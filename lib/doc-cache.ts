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
};

export type CachedDocumentListItem = {
  id: string;
  title: string;
  updated_at: string;
};

const DB_NAME = "mushpot";
const DB_VERSION = 1;
const DOCS_STORE = "documents";
const META_STORE = "meta";
const LAST_ACTIVE_OWNER_KEY = "last-active-owner";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        const store = db.createObjectStore(DOCS_STORE, { keyPath: "id" });
        store.createIndex("updated_at", "updated_at");
        store.createIndex("owner", "owner");
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
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DOCS_STORE, "readonly");
      const request = tx.objectStore(DOCS_STORE).get(id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
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

export async function putCachedDocument(doc: CachedDocument): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DOCS_STORE, "readwrite");
      tx.objectStore(DOCS_STORE).put(doc);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently ignore – cache is best-effort
  }
}

export async function putCachedDocuments(docs: CachedDocument[]): Promise<void> {
  if (docs.length === 0) return;
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DOCS_STORE, "readwrite");
      const store = tx.objectStore(DOCS_STORE);
      for (const doc of docs) {
        store.put(doc);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently ignore
  }
}

export async function deleteCachedDocument(id: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DOCS_STORE, "readwrite");
      tx.objectStore(DOCS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently ignore
  }
}

export async function getAllCachedDocuments(): Promise<CachedDocumentListItem[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DOCS_STORE, "readonly");
      const request = tx.objectStore(DOCS_STORE).getAll();
      request.onsuccess = () => {
        const docs = (request.result as CachedDocument[])
          .map((d) => ({ id: d.id, title: d.title, updated_at: d.updated_at }))
          .sort(
            (a, b) =>
              new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
          );
        resolve(docs);
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

export async function getAllCachedDocumentsForOwner(
  owner: string,
): Promise<CachedDocumentListItem[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DOCS_STORE, "readonly");
      const index = tx.objectStore(DOCS_STORE).index("owner");
      const request = index.getAll(owner);
      request.onsuccess = () => {
        const docs = (request.result as CachedDocument[])
          .map((doc) => ({ id: doc.id, title: doc.title, updated_at: doc.updated_at }))
          .sort(
            (a, b) =>
              new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
          );
        resolve(docs);
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Meta helpers (e.g. last sync timestamp)
// ---------------------------------------------------------------------------

export async function getMeta(key: string): Promise<string | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const request = tx.objectStore(META_STORE).get(key);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function setMeta(key: string, value: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readwrite");
      tx.objectStore(META_STORE).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently ignore
  }
}

export function getLastActiveOwner(): Promise<string | null> {
  return getMeta(LAST_ACTIVE_OWNER_KEY);
}

export function setLastActiveOwner(owner: string): Promise<void> {
  return setMeta(LAST_ACTIVE_OWNER_KEY, owner);
}

export async function clearLastActiveOwner(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readwrite");
      tx.objectStore(META_STORE).delete(LAST_ACTIVE_OWNER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently ignore
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

    // Get all existing docs to check for dirty state
    const existing: CachedDocument[] = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const existingForOwner = existing.filter((doc) => doc.owner === owner);
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
        const existingDoc = existingForOwner.find((d) => d.id === serverDoc.id);
        if (existingDoc) {
          // Update metadata but keep full content if present
          store.put({
            ...existingDoc,
            title: serverDoc.title,
            updated_at: serverDoc.updated_at,
          });
        } else {
          // New doc from server – store list metadata (content loaded on demand)
          store.put({
            id: serverDoc.id,
            owner,
            title: serverDoc.title,
            content: "",
            updated_at: serverDoc.updated_at,
            share_enabled: false,
            share_token: null,
          });
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await setMeta("lastSyncAt", new Date().toISOString());
  } catch {
    // Silently ignore
  }
}
