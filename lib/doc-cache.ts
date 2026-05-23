/**
 * IndexedDB-based document cache for offline-first, instant-load performance.
 *
 * Documents are read from local cache first (instant), then synced with the
 * server in the background. Edits are persisted locally before being sent
 * to Supabase, so the UI is never blocked by network latency.
 */

export type CachedDocument = {
  id: string;
  owner: string;
  title: string;
  content: string;
  updated_at: string;
  share_enabled: boolean;
  share_token: string | null;
  /** Timestamp of last local write – used to detect dirty docs */
  _localUpdatedAt?: number;
  /** True when local changes haven't been persisted to the server yet */
  _dirty?: boolean;
  /** Numeric IndexedDB key for dirty-document lookups. */
  _dirtyKey?: 1;
};

export type CachedDocumentListItem = {
  id: string;
  title: string;
  updated_at: string;
};

const DB_NAME = "mushpot";
const DB_VERSION = 2;
const DOCS_STORE = "documents";
const META_STORE = "meta";
const LAST_ACTIVE_OWNER_KEY = "last-active-owner";

let dbPromise: Promise<IDBDatabase> | null = null;

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
}

function getOwnerUpdatedAtRange(owner: string) {
  return IDBKeyRange.bound([owner, ""], [owner, "\uffff"]);
}

function normalizeCachedDocumentForStorage(doc: CachedDocument): CachedDocument {
  if (doc._dirty) {
    return {
      ...doc,
      _dirtyKey: 1,
    };
  }

  const cleanDoc = { ...doc };
  delete cleanDoc._dirtyKey;
  return cleanDoc;
}

function normalizeExistingDirtyKeys(store: IDBObjectStore) {
  const request = store.openCursor();

  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      return;
    }

    const document = cursor.value as CachedDocument;
    const normalizedDocument = normalizeCachedDocumentForStorage(document);
    if (normalizedDocument._dirtyKey !== document._dirtyKey) {
      const updateRequest = cursor.update(normalizedDocument);
      updateRequest.onsuccess = () => cursor.continue();
      updateRequest.onerror = () => cursor.continue();
      return;
    }

    cursor.continue();
  };
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        const store = db.createObjectStore(DOCS_STORE, { keyPath: "id" });
        ensureDocumentIndexes(store);
      } else {
        const store = request.transaction!.objectStore(DOCS_STORE);
        ensureDocumentIndexes(store);
        normalizeExistingDirtyKeys(store);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

// ---------------------------------------------------------------------------
// Document CRUD
// ---------------------------------------------------------------------------

export async function getCachedDocument(id: string): Promise<CachedDocument | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(DOCS_STORE, "readonly");
    const document = await requestToPromise<CachedDocument | undefined>(
      tx.objectStore(DOCS_STORE).get(id),
    );
    return document ?? null;
  } catch {
    return null;
  }
}

export async function getCachedDocumentForOwner(
  id: string,
  owner: string,
): Promise<CachedDocument | null> {
  const cached = await getCachedDocument(id);
  return cached?.owner === owner ? cached : null;
}

export async function getCachedDocumentListForOwner(
  owner: string,
): Promise<CachedDocumentListItem[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(DOCS_STORE, "readonly");
    const store = tx.objectStore(DOCS_STORE);
    const index = store.index("owner_updated_at");
    const documents: CachedDocumentListItem[] = [];

    await new Promise<void>((resolve, reject) => {
      const request = index.openCursor(getOwnerUpdatedAtRange(owner), "prev");

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }

        const document = cursor.value as CachedDocument;
        documents.push({
          id: document.id,
          title: document.title,
          updated_at: document.updated_at,
        });
        cursor.continue();
      };

      request.onerror = () => reject(request.error);
    });

    return documents;
  } catch {
    return [];
  }
}

export async function reconcileCachedDocumentWithServer(
  serverDocument: CachedDocument,
): Promise<CachedDocument> {
  const cachedDocument = await getCachedDocumentForOwner(
    serverDocument.id,
    serverDocument.owner,
  );

  if (cachedDocument?._dirty) {
    return cachedDocument;
  }

  const nextDocument: CachedDocument = {
    ...serverDocument,
    _dirty: false,
  };
  await putCachedDocument(nextDocument);
  return nextDocument;
}

export async function putCachedDocument(doc: CachedDocument): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(DOCS_STORE, "readwrite");
    tx.objectStore(DOCS_STORE).put(normalizeCachedDocumentForStorage(doc));
    await waitForTransaction(tx);
  } catch {
    // Silently ignore – cache is best-effort
  }
}

export async function deleteCachedDocument(id: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(DOCS_STORE, "readwrite");
    tx.objectStore(DOCS_STORE).delete(id);
    await waitForTransaction(tx);
  } catch {
    // Silently ignore
  }
}

// ---------------------------------------------------------------------------
// Meta helpers (e.g. last sync timestamp)
// ---------------------------------------------------------------------------

export async function setMeta(key: string, value: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ key, value });
    await waitForTransaction(tx);
  } catch {
    // Silently ignore
  }
}

export async function getMeta(key: string): Promise<string | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE, "readonly");
    const meta = await requestToPromise<{ value?: string } | undefined>(
      tx.objectStore(META_STORE).get(key),
    );
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
    // Silently ignore
  }
}

// ---------------------------------------------------------------------------
// Dirty document helpers
// ---------------------------------------------------------------------------

/**
 * Returns all documents that have unsaved local changes.
 */
export async function getDirtyDocuments(): Promise<CachedDocument[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(DOCS_STORE, "readonly");
    const documents = await requestToPromise<CachedDocument[]>(
      tx.objectStore(DOCS_STORE).index("dirty").getAll(1),
    );
    return documents;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

/**
 * Replace the full local cache with fresh server data, preserving any local
 * dirty documents that haven't been synced yet.
 */
export async function syncDocumentList(
  serverDocs: CachedDocumentListItem[],
  owner: string,
): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(DOCS_STORE, "readwrite");
    const store = tx.objectStore(DOCS_STORE);

    const existingForOwner = await requestToPromise<CachedDocument[]>(
      store.index("owner").getAll(owner),
    );
    const existingById = new Map(existingForOwner.map((doc) => [doc.id, doc]));
    const dirtyIds = new Set(existingForOwner.filter((d) => d._dirty).map((d) => d.id));
    const serverIds = new Set(serverDocs.map((d) => d.id));

    // Remove docs that no longer exist on server (unless dirty)
    for (const doc of existingForOwner) {
      if (!serverIds.has(doc.id) && !doc._dirty) {
        store.delete(doc.id);
      }
    }

    // Update non-dirty docs with server metadata
    for (const serverDoc of serverDocs) {
      if (!dirtyIds.has(serverDoc.id)) {
        const existingDoc = existingById.get(serverDoc.id);
        if (existingDoc) {
          // Update metadata but keep full content if present
          store.put(
            normalizeCachedDocumentForStorage({
              ...existingDoc,
              title: serverDoc.title,
              updated_at: serverDoc.updated_at,
            }),
          );
        } else {
          // New doc from server – store list metadata (content loaded on demand)
          store.put(
            normalizeCachedDocumentForStorage({
              id: serverDoc.id,
              owner,
              title: serverDoc.title,
              content: "",
              updated_at: serverDoc.updated_at,
              share_enabled: false,
              share_token: null,
            }),
          );
        }
      }
    }

    await waitForTransaction(tx);

    await setMeta("lastSyncAt", new Date().toISOString());
  } catch {
    // Silently ignore
  }
}
