/**
 * IndexedDB-based document cache for offline-first, instant-load performance.
 *
 * Cache access is authorized by an owner-scoped generation stored in the same
 * IndexedDB transaction as the document operation. Deactivating an owner
 * advances that generation, so work started by an older authenticated session
 * cannot read, write, or delete data after the session changes.
 */

import {
  compareDocumentListItems,
  isCachedDocumentNewerThanServerListItem,
  isCompleteDocument,
  mergeDocumentListMetadata,
  shouldPreserveExistingDocument,
  toDocumentListItem,
  toMetadataDocument,
  toStoredCompleteDocument,
  type CachedCompleteDocument,
  type CachedDocument,
  type CachedDocumentListItem,
  type CachedDocumentRecord,
} from "@/lib/document-cache-record";

export type {
  CachedCompleteDocument,
  CachedDocument,
  CachedDocumentListItem,
  CachedDocumentRecord,
  CachedMetadataDocument,
} from "@/lib/document-cache-record";

const DB_NAME = "mushpot";
const DB_VERSION = 4;
const DOCS_STORE = "documents";
const META_STORE = "meta";
const LAST_ACTIVE_OWNER_KEY = "last-active-owner";
const OWNER_CACHE_STATE_KEY_PREFIX = "document-cache-owner-state:";
const LAST_SYNC_KEY_PREFIX = "document-cache-last-sync:";
const DOCUMENT_DELETION_TOMBSTONE_KEY_PREFIX =
  "document-cache-deletion-tombstone:";

type DocumentCacheOwnerState = {
  enabled: boolean;
  generation: number;
  key: string;
  owner: string;
};

type DocumentCacheDeletionTombstone = {
  deletedAt: string;
  documentId: string;
  generation: number;
  key: string;
  owner: string;
};

export type DocumentCacheWriteToken = Readonly<{
  generation: number;
  owner: string;
}>;

let dbPromise: Promise<IDBDatabase> | null = null;
const activeOwnerGenerations = new Map<string, number>();
const ownerStateOperationIds = new Map<string, number>();
const ownerStateMutationQueues = new Map<string, Promise<void>>();

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function ensureDocumentIndexes(store: IDBObjectStore) {
  if (!store.indexNames.contains("updated_at")) {
    store.createIndex("updated_at", "updated_at");
  }
  if (!store.indexNames.contains("owner")) {
    store.createIndex("owner", "owner");
  }
  if (!store.indexNames.contains("owner_updated_at")) {
    store.createIndex("owner_updated_at", ["owner", "updated_at"]);
  }
  if (!store.indexNames.contains("dirty")) {
    store.createIndex("dirty", "_dirtyKey");
  }
  if (!store.indexNames.contains("owner_dirty")) {
    store.createIndex("owner_dirty", ["owner", "_dirtyKey"]);
  }
}

function getOwnerUpdatedAtRange(owner: string) {
  return IDBKeyRange.bound([owner, ""], [owner, "\uffff"]);
}

function getOwnerCacheStateKey(owner: string) {
  return `${OWNER_CACHE_STATE_KEY_PREFIX}${owner}`;
}

function getOwnerLastSyncKey(owner: string) {
  return `${LAST_SYNC_KEY_PREFIX}${owner}`;
}

function getOwnerDocumentDeletionTombstonePrefix(owner: string) {
  return `${DOCUMENT_DELETION_TOMBSTONE_KEY_PREFIX}${encodeURIComponent(owner)}:`;
}

function getDocumentDeletionTombstoneKey(owner: string, documentId: string) {
  return `${getOwnerDocumentDeletionTombstonePrefix(owner)}${
    encodeURIComponent(documentId)
  }`;
}

function getOwnerDocumentDeletionTombstoneRange(owner: string) {
  const prefix = getOwnerDocumentDeletionTombstonePrefix(owner);
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
}

function isDocumentCacheDeletionTombstone(
  value: DocumentCacheDeletionTombstone | undefined,
  owner: string,
  documentId: string,
  generation: number,
): value is DocumentCacheDeletionTombstone {
  return (
    value?.key === getDocumentDeletionTombstoneKey(owner, documentId) &&
    value.owner === owner &&
    value.documentId === documentId &&
    value.generation === generation
  );
}

function beginOwnerStateOperation(owner: string) {
  const operationId = (ownerStateOperationIds.get(owner) ?? 0) + 1;
  ownerStateOperationIds.set(owner, operationId);
  return operationId;
}

function isCurrentOwnerStateOperation(owner: string, operationId: number) {
  return (ownerStateOperationIds.get(owner) ?? 0) === operationId;
}

async function runOwnerStateMutation(
  owner: string,
  mutation: () => Promise<void>,
) {
  const previousMutation = ownerStateMutationQueues.get(owner);
  const currentMutation = (previousMutation ?? Promise.resolve())
    .catch(() => undefined)
    .then(mutation);
  ownerStateMutationQueues.set(owner, currentMutation);

  try {
    await currentMutation;
  } finally {
    if (ownerStateMutationQueues.get(owner) === currentMutation) {
      ownerStateMutationQueues.delete(owner);
    }
  }
}

function isDocumentCacheOwnerState(
  value: DocumentCacheOwnerState | undefined,
  owner: string,
): value is DocumentCacheOwnerState {
  return (
    value?.key === getOwnerCacheStateKey(owner) &&
    value.owner === owner &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    typeof value.enabled === "boolean"
  );
}

function getNextOwnerGeneration(
  state: DocumentCacheOwnerState | undefined,
  owner: string,
) {
  return isDocumentCacheOwnerState(state, owner) ? state.generation + 1 : 1;
}

function isTokenAuthorized(
  state: DocumentCacheOwnerState | undefined,
  token: DocumentCacheWriteToken,
) {
  return (
    isDocumentCacheOwnerState(state, token.owner) &&
    state.enabled &&
    state.generation === token.generation
  );
}

/**
 * v2 did not distinguish a list placeholder from a real empty document.
 * Preserve records that are definitely complete (dirty or non-empty) and
 * migrate ambiguous clean empty records to metadata so they must be fetched
 * before the editor can use them.
 */
function migrateExistingDocuments(store: IDBObjectStore) {
  const request = store.openCursor();

  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      return;
    }

    const existing = cursor.value as CachedDocumentRecord | CachedDocument;
    let migrated: CachedDocumentRecord;

    if (existing.kind === "metadata") {
      migrated = toMetadataDocument(existing);
    } else if (
      existing.kind === "complete" ||
      existing._dirty === true ||
      existing.content !== ""
    ) {
      migrated = toStoredCompleteDocument(existing);
    } else {
      migrated = toMetadataDocument(existing);
    }

    const updateRequest = cursor.update(migrated);
    updateRequest.onsuccess = () => cursor.continue();
    updateRequest.onerror = () => cursor.continue();
  };
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        const store = db.createObjectStore(DOCS_STORE, { keyPath: "id" });
        ensureDocumentIndexes(store);
      } else {
        const store = request.transaction!.objectStore(DOCS_STORE);
        ensureDocumentIndexes(store);
        if (event.oldVersion < 3) {
          migrateExistingDocuments(store);
        }
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      // A blocked request can still succeed after an older tab closes. Replace
      // its rejected promise so later cache operations can use the connection.
      dbPromise = Promise.resolve(db);
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      // The open request is still pending. Keep its rejected promise so later
      // callers fail promptly instead of queuing behind the blocked upgrade.
      reject(new Error("Document cache upgrade was blocked."));
    };
  });

  return dbPromise;
}

export function getDocumentCacheWriteToken(
  owner: string,
): DocumentCacheWriteToken | null {
  const generation = activeOwnerGenerations.get(owner);
  return generation === undefined ? null : { generation, owner };
}

// ---------------------------------------------------------------------------
// Document reads and writes
// ---------------------------------------------------------------------------

/**
 * Returns either metadata or a complete record for an active owner. The owner
 * state and document are read in the same transaction.
 */
export async function getCachedDocumentRecordForOwner(
  id: string,
  owner: string,
  token = getDocumentCacheWriteToken(owner),
): Promise<CachedDocumentRecord | null> {
  if (!token || token.owner !== owner) {
    return null;
  }

  try {
    const db = await openDB();
    const tx = db.transaction([DOCS_STORE, META_STORE], "readonly");
    const transactionDone = waitForTransaction(tx);
    const [ownerState, document, deletionTombstone] = await Promise.all([
      requestToPromise<DocumentCacheOwnerState | undefined>(
        tx.objectStore(META_STORE).get(getOwnerCacheStateKey(owner)),
      ),
      requestToPromise<CachedDocumentRecord | undefined>(
        tx.objectStore(DOCS_STORE).get(id),
      ),
      requestToPromise<DocumentCacheDeletionTombstone | undefined>(
        tx.objectStore(META_STORE).get(
          getDocumentDeletionTombstoneKey(owner, id),
        ),
      ),
    ]);
    await transactionDone;

    return isTokenAuthorized(ownerState, token) &&
        !isDocumentCacheDeletionTombstone(
          deletionTombstone,
          owner,
          id,
          token.generation,
        ) &&
        document?.owner === owner
      ? document
      : null;
  } catch {
    return null;
  }
}

/** Backward-compatible owner-scoped record read. */
export function getCachedDocument(
  id: string,
  owner: string,
  token = getDocumentCacheWriteToken(owner),
) {
  return getCachedDocumentRecordForOwner(id, owner, token);
}

/**
 * Returns only complete editor data. Metadata placeholders deliberately resolve
 * to null so an offline list record can never overwrite real server content.
 */
export async function getCachedDocumentForOwner(
  id: string,
  owner: string,
  token = getDocumentCacheWriteToken(owner),
): Promise<CachedCompleteDocument | null> {
  const document = await getCachedDocumentRecordForOwner(id, owner, token);
  return isCompleteDocument(document) ? document : null;
}

export async function getCachedDocumentListForOwner(
  owner: string,
  token = getDocumentCacheWriteToken(owner),
): Promise<CachedDocumentListItem[]> {
  if (!token || token.owner !== owner) {
    return [];
  }

  try {
    const db = await openDB();
    const tx = db.transaction([DOCS_STORE, META_STORE], "readonly");
    const transactionDone = waitForTransaction(tx);
    const metaStore = tx.objectStore(META_STORE);
    const stateRequest = requestToPromise<DocumentCacheOwnerState | undefined>(
      metaStore.get(getOwnerCacheStateKey(owner)),
    );
    const tombstonesRequest = requestToPromise<
      DocumentCacheDeletionTombstone[]
    >(
      metaStore.getAll(getOwnerDocumentDeletionTombstoneRange(owner)),
    );
    const documents: CachedDocumentListItem[] = [];

    const cursorDone = new Promise<void>((resolve, reject) => {
      const request = tx
        .objectStore(DOCS_STORE)
        .index("owner_updated_at")
        .openCursor(getOwnerUpdatedAtRange(owner), "prev");

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }

        const document = cursor.value as CachedDocumentRecord;
        documents.push(toDocumentListItem(document));
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    const [ownerState, deletionTombstones] = await Promise.all([
      stateRequest,
      tombstonesRequest,
      cursorDone,
    ]);
    await transactionDone;
    if (!isTokenAuthorized(ownerState, token)) {
      return [];
    }

    const deletedDocumentIds = new Set(
      deletionTombstones
        .filter(
          (tombstone) =>
            tombstone.owner === owner &&
            tombstone.generation === token.generation,
        )
        .map((tombstone) => tombstone.documentId),
    );
    return documents
      .filter((document) => !deletedDocumentIds.has(document.id))
      .sort(compareDocumentListItems);
  } catch {
    return [];
  }
}

export async function reconcileCachedDocumentWithServer(
  serverDocument: CachedDocument,
  token = getDocumentCacheWriteToken(serverDocument.owner),
  canWrite: () => boolean = () => true,
): Promise<CachedCompleteDocument> {
  const nextDocument = toStoredCompleteDocument({
    ...serverDocument,
    _dirty: false,
  });

  if (!token || token.owner !== serverDocument.owner) {
    return nextDocument;
  }

  const cachedDocument = await getCachedDocumentForOwner(
    serverDocument.id,
    serverDocument.owner,
    token,
  );
  if (cachedDocument?._dirty) {
    return cachedDocument;
  }

  await putCachedDocument(nextDocument, token, canWrite);
  return nextDocument;
}

export async function putCachedDocument(
  document: CachedDocument,
  token = getDocumentCacheWriteToken(document.owner),
  canWrite: () => boolean = () => true,
): Promise<boolean> {
  if (!token || token.owner !== document.owner) {
    return false;
  }

  try {
    const db = await openDB();
    const tx = db.transaction([DOCS_STORE, META_STORE], "readwrite");
    const transactionDone = waitForTransaction(tx);
    const documentStore = tx.objectStore(DOCS_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const [ownerState, existingDocument, deletionTombstone] = await Promise.all([
      requestToPromise<DocumentCacheOwnerState | undefined>(
        metaStore.get(getOwnerCacheStateKey(document.owner)),
      ),
      requestToPromise<CachedDocumentRecord | undefined>(
        documentStore.get(document.id),
      ),
      requestToPromise<DocumentCacheDeletionTombstone | undefined>(
        metaStore.get(
          getDocumentDeletionTombstoneKey(document.owner, document.id),
        ),
      ),
    ]);
    const authorized = isTokenAuthorized(ownerState, token);
    const incomingDocument = toStoredCompleteDocument(document);
    const stored =
      authorized &&
      canWrite() &&
      !isDocumentCacheDeletionTombstone(
        deletionTombstone,
        document.owner,
        document.id,
        token.generation,
      ) &&
      !shouldPreserveExistingDocument(existingDocument, incomingDocument);

    if (stored) {
      documentStore.put(
        mergeDocumentListMetadata(
          incomingDocument,
          isCompleteDocument(existingDocument)
            ? existingDocument._listMetadata
            : undefined,
        ),
      );
    }

    await transactionDone;
    return stored;
  } catch {
    return false;
  }
}

/**
 * Atomically tombstones and removes an owner/document cache row. The tombstone
 * blocks delayed save completions and stale list responses for the remainder
 * of the owner generation.
 */
export async function deleteCachedDocument(
  id: string,
  owner: string,
  token = getDocumentCacheWriteToken(owner),
): Promise<boolean> {
  if (!token || token.owner !== owner) {
    return false;
  }

  try {
    const db = await openDB();
    const tx = db.transaction([DOCS_STORE, META_STORE], "readwrite");
    const transactionDone = waitForTransaction(tx);
    const store = tx.objectStore(DOCS_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const [ownerState, document] = await Promise.all([
      requestToPromise<DocumentCacheOwnerState | undefined>(
        metaStore.get(getOwnerCacheStateKey(owner)),
      ),
      requestToPromise<CachedDocumentRecord | undefined>(store.get(id)),
    ]);
    const authorized =
      isTokenAuthorized(ownerState, token) &&
      (!document || document.owner === owner);
    if (authorized) {
      metaStore.put({
        deletedAt: new Date().toISOString(),
        documentId: id,
        generation: token.generation,
        key: getDocumentDeletionTombstoneKey(owner, id),
        owner,
      } satisfies DocumentCacheDeletionTombstone);
      if (document) {
        store.delete(id);
      }
    }

    await transactionDone;
    return authorized;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Owner lifecycle
// ---------------------------------------------------------------------------

async function disableDocumentCacheForOwner(
  owner: string,
  purgeDirtyDocuments: boolean,
): Promise<void> {
  if (!owner) {
    return;
  }

  const operationId = beginOwnerStateOperation(owner);
  activeOwnerGenerations.delete(owner);

  try {
    await runOwnerStateMutation(owner, async () => {
      const db = await openDB();
      const tx = db.transaction([DOCS_STORE, META_STORE], "readwrite");
      const transactionDone = waitForTransaction(tx);
      const documentStore = tx.objectStore(DOCS_STORE);
      const metaStore = tx.objectStore(META_STORE);
      const [ownerState, documents, lastActiveOwner, tombstoneKeys] =
        await Promise.all([
          requestToPromise<DocumentCacheOwnerState | undefined>(
            metaStore.get(getOwnerCacheStateKey(owner)),
          ),
          requestToPromise<CachedDocumentRecord[]>(
            documentStore.index("owner").getAll(owner),
          ),
          requestToPromise<{ value?: string } | undefined>(
            metaStore.get(LAST_ACTIVE_OWNER_KEY),
          ),
          requestToPromise<IDBValidKey[]>(
            metaStore.getAllKeys(getOwnerDocumentDeletionTombstoneRange(owner)),
          ),
        ]);

      metaStore.put({
        enabled: false,
        generation: getNextOwnerGeneration(ownerState, owner),
        key: getOwnerCacheStateKey(owner),
        owner,
      } satisfies DocumentCacheOwnerState);

      if (lastActiveOwner?.value === owner) {
        metaStore.delete(LAST_ACTIVE_OWNER_KEY);
      }

      for (const tombstoneKey of tombstoneKeys) {
        metaStore.delete(tombstoneKey);
      }

      for (const document of documents) {
        const retainDirtyDocument =
          !purgeDirtyDocuments &&
          isCompleteDocument(document) &&
          document._dirty === true;
        if (!retainDirtyDocument) {
          documentStore.delete(document.id);
        }
      }

      await transactionDone;
    });
  } catch {
    // Cache cleanup is best-effort. The in-memory generation remains disabled.
  } finally {
    if (isCurrentOwnerStateOperation(owner, operationId)) {
      activeOwnerGenerations.delete(owner);
    }
  }
}

/**
 * Quarantines an owner's unsynced drafts while removing clean data. Reads and
 * writes stay disabled until the same owner is authenticated again.
 */
export function deactivateDocumentCacheForOwner(owner: string): Promise<void> {
  return disableDocumentCacheForOwner(owner, false);
}

/** Permanently removes both clean and dirty cached data for an owner. */
export function purgeDocumentCacheForOwner(owner: string): Promise<void> {
  return disableDocumentCacheForOwner(owner, true);
}

/** Compatibility alias for callers that explicitly intend a full purge. */
export function clearCachedDocumentsForOwner(owner: string): Promise<void> {
  return purgeDocumentCacheForOwner(owner);
}

export async function activateDocumentCacheForOwner(owner: string): Promise<void> {
  if (!owner) {
    return;
  }

  // Repeated authenticated activation calls share the current generation.
  // A concurrent deactivation advances the operation ID and wins over an
  // activation that started earlier.
  const operationId = ownerStateOperationIds.get(owner) ?? 0;

  try {
    await runOwnerStateMutation(owner, async () => {
      const db = await openDB();
      const tx = db.transaction(META_STORE, "readwrite");
      const transactionDone = waitForTransaction(tx);
      const metaStore = tx.objectStore(META_STORE);
      const existingState = await requestToPromise<
        DocumentCacheOwnerState | undefined
      >(metaStore.get(getOwnerCacheStateKey(owner)));
      const generation =
        isDocumentCacheOwnerState(existingState, owner) && existingState.enabled
          ? existingState.generation
          : getNextOwnerGeneration(existingState, owner);

      metaStore.put({
        enabled: true,
        generation,
        key: getOwnerCacheStateKey(owner),
        owner,
      } satisfies DocumentCacheOwnerState);
      metaStore.put({ key: LAST_ACTIVE_OWNER_KEY, value: owner });
      await transactionDone;

      if (isCurrentOwnerStateOperation(owner, operationId)) {
        activeOwnerGenerations.set(owner, generation);
      }
    });
  } catch {
    if (isCurrentOwnerStateOperation(owner, operationId)) {
      activeOwnerGenerations.delete(owner);
    }
  }
}

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

export async function setMeta(key: string, value: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ key, value });
    await waitForTransaction(tx);
  } catch {
    // Metadata is best-effort.
  }
}

export async function getMeta(key: string): Promise<string | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE, "readonly");
    const transactionDone = waitForTransaction(tx);
    const meta = await requestToPromise<{ value?: string } | undefined>(
      tx.objectStore(META_STORE).get(key),
    );
    await transactionDone;
    return meta?.value ?? null;
  } catch {
    return null;
  }
}

export function setLastActiveOwner(owner: string): Promise<void> {
  return setMeta(LAST_ACTIVE_OWNER_KEY, owner);
}

export function getLastActiveOwner(): Promise<string | null> {
  return getMeta(LAST_ACTIVE_OWNER_KEY);
}

export async function clearLastActiveOwner(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).delete(LAST_ACTIVE_OWNER_KEY);
    await waitForTransaction(tx);
  } catch {
    // Metadata is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Dirty documents and list sync
// ---------------------------------------------------------------------------

export async function getDirtyDocuments(
  owner: string,
  token = getDocumentCacheWriteToken(owner),
): Promise<CachedCompleteDocument[]> {
  if (!owner || !token || token.owner !== owner) {
    throw new Error("The document cache is not active for this owner.");
  }

  const db = await openDB();
  const tx = db.transaction([DOCS_STORE, META_STORE], "readonly");
  const transactionDone = waitForTransaction(tx);
  const [ownerState, documents] = await Promise.all([
    requestToPromise<DocumentCacheOwnerState | undefined>(
      tx.objectStore(META_STORE).get(getOwnerCacheStateKey(owner)),
    ),
    requestToPromise<CachedDocumentRecord[]>(
      tx.objectStore(DOCS_STORE).index("owner_dirty").getAll([owner, 1]),
    ),
  ]);
  await transactionDone;

  if (!isTokenAuthorized(ownerState, token)) {
    throw new Error("The document cache changed while drafts were being read.");
  }

  return documents.filter(
    (document): document is CachedCompleteDocument =>
      isCompleteDocument(document) && document._dirty === true,
  );
}

/**
 * Reconciles list metadata while preserving complete documents and dirty local
 * drafts. New list rows are metadata-only until the editor fetches full data.
 */
export async function syncDocumentList(
  serverDocuments: CachedDocumentListItem[],
  owner: string,
  token = getDocumentCacheWriteToken(owner),
): Promise<CachedDocumentListItem[] | null> {
  if (!token || token.owner !== owner) {
    return null;
  }

  try {
    const db = await openDB();
    const tx = db.transaction([DOCS_STORE, META_STORE], "readwrite");
    const transactionDone = waitForTransaction(tx);
    const documentStore = tx.objectStore(DOCS_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const [ownerState, existingForOwner, deletionTombstones] =
      await Promise.all([
        requestToPromise<DocumentCacheOwnerState | undefined>(
          metaStore.get(getOwnerCacheStateKey(owner)),
        ),
        requestToPromise<CachedDocumentRecord[]>(
          documentStore.index("owner").getAll(owner),
        ),
        requestToPromise<DocumentCacheDeletionTombstone[]>(
          metaStore.getAll(getOwnerDocumentDeletionTombstoneRange(owner)),
        ),
      ]);

    if (!isTokenAuthorized(ownerState, token)) {
      await transactionDone;
      return null;
    }

    const deletedDocumentIds = new Set(
      deletionTombstones
        .filter(
          (tombstone) =>
            tombstone.owner === owner &&
            tombstone.generation === token.generation,
        )
        .map((tombstone) => tombstone.documentId),
    );
    const existingById = new Map(
      existingForOwner.map((document) => [document.id, document]),
    );
    const reconciledById = new Map(existingById);
    const dirtyIds = new Set(
      existingForOwner
        .filter(
          (document) =>
            isCompleteDocument(document) && document._dirty === true,
        )
        .map((document) => document.id),
    );
    const serverById = new Map(
      serverDocuments.map((document) => [document.id, document]),
    );
    const serverIds = new Set(serverById.keys());

    for (const document of existingForOwner) {
      if (
        deletedDocumentIds.has(document.id) ||
        (!serverIds.has(document.id) && !dirtyIds.has(document.id))
      ) {
        documentStore.delete(document.id);
        reconciledById.delete(document.id);
      }
    }

    for (const serverDocument of serverDocuments) {
      if (deletedDocumentIds.has(serverDocument.id)) {
        continue;
      }

      const existingDocument = existingById.get(serverDocument.id);
      const existingListItem = existingDocument
        ? toDocumentListItem(existingDocument)
        : undefined;
      if (
        existingListItem &&
        ((existingListItem.title === serverDocument.title &&
          existingListItem.updated_at === serverDocument.updated_at) ||
          isCachedDocumentNewerThanServerListItem(
            existingListItem,
            serverDocument,
          ))
      ) {
        continue;
      }

      if (isCompleteDocument(existingDocument)) {
        const nextDocument = mergeDocumentListMetadata(existingDocument, {
          title: serverDocument.title,
          updated_at: serverDocument.updated_at,
        });
        if (nextDocument !== existingDocument) documentStore.put(nextDocument);
        reconciledById.set(serverDocument.id, nextDocument);
      } else {
        const nextDocument = toMetadataDocument({
          ...serverDocument,
          owner,
        });
        documentStore.put(nextDocument);
        reconciledById.set(serverDocument.id, nextDocument);
      }
    }

    metaStore.put({
      key: getOwnerLastSyncKey(owner),
      value: new Date().toISOString(),
    });
    await transactionDone;

    return Array.from(reconciledById.values())
      .map(toDocumentListItem)
      .sort(compareDocumentListItems);
  } catch {
    // Cache reconciliation is best-effort.
    return null;
  }
}
