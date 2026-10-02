import {
  compareDocumentListItems,
  isCachedDocumentNewerThanServerListItem,
  type CachedDocumentListItem,
} from "@/lib/document-cache-record";
import {
  subscribeToDocumentCacheChanges,
  type DocumentCacheChange,
} from "@/lib/document-cache-events";
import { getDocumentCacheWriteToken, type DocumentCacheWriteToken } from "@/lib/doc-cache";
import type { DocumentWriteSession } from "@/lib/document-write-coordinator";

type LocalChange = {
  document: CachedDocumentListItem | null;
  revision: number;
  dirty: boolean;
};

/** Metadata retained only for one mounted, authenticated private session. */
export function createDocumentListSession(writeSession: DocumentWriteSession) {
  let active = true;
  let documents: CachedDocumentListItem[] | null = null;
  let generation: number | null = null;
  let revision = 0;
  let replacementRevision = 0;
  let unsubscribeFromCache: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const localChanges = new Map<string, LocalChange>();
  const deletedIds = new Set<string>();
  const pendingLoads = new Set<{ revision: number }>();

  const isCurrent = (owner: string | null) =>
    active && writeSession.active && owner === writeSession.owner;
  const notify = () => { for (const listener of listeners) listener(); };
  const clear = () => {
    documents = null;
    localChanges.clear();
    deletedIds.clear();
    replacementRevision = ++revision;
    notify();
  };
  const bindToken = (token: DocumentCacheWriteToken | null, allowGenerationChange = false) => {
    if (!isCurrent(writeSession.owner) || (token && token.owner !== writeSession.owner)) {
      return false;
    }
    if (token) {
      if (generation !== null && generation !== token.generation) {
        if (!allowGenerationChange) return false;
        clear();
      }
      generation = token.generation;
    }
    return true;
  };
  const replace = (incoming: CachedDocumentListItem[], afterRevision: number) => {
    // Project only list fields, even when a caller passes a complete document.
    const byId = new Map(incoming.map(({ id, title, updated_at }) => [
      id, { id, title, updated_at },
    ]));
    for (const [id, change] of localChanges) {
      let local = change.document;
      const incomingMetadata = byId.get(id);
      if (change.dirty && local && incomingMetadata &&
          isCachedDocumentNewerThanServerListItem(incomingMetadata, local)) {
        // Preserve unsaved titles without rolling back a newer list revision.
        local = { ...local, updated_at: incomingMetadata.updated_at };
        localChanges.set(id, { ...change, document: local });
      }
      if (change.revision <= afterRevision) continue;
      if (local) byId.set(id, local);
      else byId.delete(id);
    }
    for (const id of deletedIds) byId.delete(id);
    documents = Array.from(byId.values()).sort(compareDocumentListItems);
    replacementRevision = ++revision;
    notify();
    return documents;
  };
  const retire = () => {
    if (!active) return;
    active = false;
    unsubscribeFromCache?.();
    unsubscribeFromCache = undefined;
    pendingLoads.clear();
    clear();
  };
  const recordMutation = (
    id: string, document: CachedDocumentListItem | null, dirty = false,
  ) => {
    if (document && deletedIds.has(id)) return;
    localChanges.set(id, { document, revision: ++revision, dirty });
    if (!document) deletedIds.add(id);
    if (documents !== null) replace(documents, -1);
  };
  const receiveCacheChange = (change: DocumentCacheChange) => {
    if (change.type === "invalidate") {
      if (change.owner === writeSession.owner) retire();
      return;
    }
    const currentToken = getDocumentCacheWriteToken(writeSession.owner);
    if (!currentToken || currentToken.generation !== change.token.generation ||
        !bindToken(change.token)) return;
    if (change.type === "replace") {
      // A query begun before a create/edit/delete cannot undo that mutation.
      const oldestLoad = Math.min(revision, ...Array.from(pendingLoads, (load) => load.revision));
      replace(change.documents, oldestLoad);
      for (const [id, local] of localChanges) {
        if (local.revision <= oldestLoad && !local.dirty) localChanges.delete(id);
      }
      return;
    }
    const id = change.type === "delete" ? change.documentId : change.document.id;
    const document = change.type === "delete" ? null : {
      id, title: change.document.title, updated_at: change.document.updated_at,
    };
    recordMutation(id, document, change.type === "upsert" && change.dirty === true);
  };

  return {
    owner: writeSession.owner,
    isCurrent,
    get active() { return active && writeSession.active; },
    getSnapshot: () => isCurrent(writeSession.owner) ? documents : null,
    // Server rendering never reads a browser session snapshot.
    getServerSnapshot: () => null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    observe() {
      if (active && !unsubscribeFromCache) {
        unsubscribeFromCache = subscribeToDocumentCacheChanges(receiveCacheChange);
      }
    },
    retire,
    confirmUpsert(owner: string, { id, title, updated_at }: CachedDocumentListItem) {
      if (isCurrent(owner)) recordMutation(id, { id, title, updated_at });
    },
    confirmDeletion(owner: string, documentId: string) {
      if (isCurrent(owner)) recordMutation(documentId, null);
    },
    captureRevision: () => revision,
    beginLoad() {
      const load = { revision };
      pendingLoads.add(load);
      return () => { pendingLoads.delete(load); };
    },
    publishCacheRead(
      incoming: CachedDocumentListItem[],
      token: DocumentCacheWriteToken | null,
      readRevision: number,
      authoritative = false,
    ) {
      const currentToken = getDocumentCacheWriteToken(writeSession.owner);
      if (!token || !currentToken || currentToken.generation !== token.generation ||
          !bindToken(token, true)) return documents;
      // Empty reads also represent unavailable IndexedDB. Only a reconciled
      // remote result can establish an empty list or clear a retained snapshot.
      if (!authoritative && incoming.length === 0) return documents;
      if (documents !== null && readRevision < replacementRevision) return documents;
      return replace(incoming, readRevision);
    },
    publishRemoteFallback(incoming: CachedDocumentListItem[]) {
      if (!isCurrent(writeSession.owner)) return null;
      // Without durable reconciliation, keep committed local metadata/tombstones.
      return replace(incoming, -1);
    },
  };
}

export type DocumentListSession = ReturnType<typeof createDocumentListSession>;
