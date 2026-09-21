import type { DocumentCacheWriteToken } from "@/lib/doc-cache";
import type {
  PersistableDocumentSnapshot,
  PersistDocumentResult,
} from "@/lib/document-sync";

let sessionGeneration = 0;

/** An authentication lifetime, including when IndexedDB is unavailable. */
export function createDocumentWriteSession(owner: string) {
  let active = true;
  return {
    owner,
    generation: ++sessionGeneration,
    get active() {
      return active;
    },
    activate() {
      active = true;
    },
    deactivate() {
      active = false;
    },
  };
}

export type DocumentWriteSession = ReturnType<
  typeof createDocumentWriteSession
>;
export type DocumentWriteEvent = {
  snapshot: PersistableDocumentSnapshot;
  result: PersistDocumentResult;
};

type Entry = {
  tail: Promise<unknown>;
  versions: Set<string>;
  saved?: DocumentWriteEvent;
  conflict?: DocumentWriteEvent;
};

type Scope = {
  cacheWriteToken: DocumentCacheWriteToken | null;
  session?: DocumentWriteSession;
};

type CoordinatorOptions = {
  isCurrent: (owner: string, scope: Scope) => boolean;
  confirmCache?: (
    snapshot: PersistableDocumentSnapshot,
    result: PersistDocumentResult,
    scope: Scope,
  ) => Promise<PersistDocumentResult>;
  persist: (
    snapshot: PersistableDocumentSnapshot,
    scope: Scope,
  ) => Promise<PersistDocumentResult>;
};

function sameContent(
  a: PersistableDocumentSnapshot,
  b: PersistableDocumentSnapshot,
) {
  return (
    (a.title.trim() || "Untitled") === (b.title.trim() || "Untitled") &&
    a.content === b.content
  );
}

export function skippedDocumentWrite(
  status: "cancelled" | "superseded",
  title: string,
): PersistDocumentResult {
  return {
    status,
    cacheUpdated: false,
    conflict: false,
    ok: false,
    persistedTitle: title.trim() || "Untitled",
    updatedAt: null,
  };
}

/**
 * Serializes editor and background writes. Only a version produced by this
 * coordinator can advance a queued draft's CAS baseline. A conflict never can.
 * Other tabs/devices still contend through the database's updated_at filter.
 */
export function createDocumentWriteCoordinator({
  isCurrent,
  persist,
  confirmCache,
}: CoordinatorOptions) {
  const sessions = new WeakMap<DocumentWriteSession, Map<string, Entry>>();
  const fallbackEntries = new Map<string, Entry>();
  const listeners = new Set<
    (event: DocumentWriteEvent, scope: Scope) => void
  >();

  return {
    subscribe(listener: (event: DocumentWriteEvent, scope: Scope) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enqueue(
      snapshot: PersistableDocumentSnapshot,
      scope: Scope,
    ): Promise<PersistDocumentResult> {
      let entries = fallbackEntries;
      if (scope.session) {
        entries = sessions.get(scope.session) ?? new Map();
        sessions.set(scope.session, entries);
      }
      const key = JSON.stringify([
        snapshot.owner,
        scope.cacheWriteToken?.generation,
        snapshot.id,
      ]);
      const entry = entries.get(key) ?? {
        tail: Promise.resolve(),
        versions: new Set<string>(),
      };
      entries.set(key, entry);

      const run = async () => {
        if (!isCurrent(snapshot.owner, scope)) {
          return skippedDocumentWrite("cancelled", snapshot.title);
        }
        if (
          entry.conflict &&
          (snapshot.updated_at === entry.conflict.snapshot.updated_at ||
            entry.versions.has(snapshot.updated_at))
        ) {
          return entry.conflict.result;
        }
        const saved = entry.saved;
        if (
          saved &&
          !snapshot._baseVersionUntrusted &&
          entry.versions.has(snapshot.updated_at)
        ) {
          if (sameContent(snapshot, saved.snapshot)) {
            const confirmedSnapshot = {
              ...snapshot,
              _localUpdatedAt:
                saved.snapshot._localUpdatedAt === undefined
                  ? snapshot._localUpdatedAt
                  : snapshot._localUpdatedAt === undefined
                    ? saved.snapshot._localUpdatedAt
                    : Math.max(
                        snapshot._localUpdatedAt,
                        saved.snapshot._localUpdatedAt,
                      ),
            };
            const result = confirmCache
              ? await confirmCache(confirmedSnapshot, saved.result, scope)
              : saved.result;
            if (!isCurrent(snapshot.owner, scope)) {
              return skippedDocumentWrite("cancelled", snapshot.title);
            }
            // A later edit can return to already-saved content. Retain its
            // revision so a delayed intermediate draft cannot overwrite it.
            const confirmedResult = result.confirmedSnapshot
              ? {
                  ...result,
                  confirmedSnapshot: {
                    ...result.confirmedSnapshot,
                    _localUpdatedAt: confirmedSnapshot._localUpdatedAt,
                  },
                }
              : result;
            entry.saved = {
              snapshot: {
                ...saved.snapshot,
                _localUpdatedAt: confirmedSnapshot._localUpdatedAt,
              },
              result: confirmedResult,
            };
            return confirmedResult;
          }
          // A delayed background read must never overwrite a newer save.
          // Missing/equal revision evidence cannot authorize a rebase.
          if (
            snapshot._localUpdatedAt === undefined ||
            saved.snapshot._localUpdatedAt === undefined ||
            snapshot._localUpdatedAt <= saved.snapshot._localUpdatedAt
          ) {
            return skippedDocumentWrite("superseded", snapshot.title);
          }
          snapshot = { ...snapshot, updated_at: saved.result.updatedAt! };
        }

        const result = await persist(snapshot, scope);
        if (!isCurrent(snapshot.owner, scope)) {
          return skippedDocumentWrite("cancelled", snapshot.title);
        }
        const event = { snapshot, result };
        if (result.status === "saved") {
          entry.versions.add(snapshot.updated_at);
          entry.versions.add(result.updatedAt!);
          entry.saved = event;
          entry.conflict = undefined;
        } else if (result.status === "conflict") {
          entry.conflict = event;
        }
        for (const listener of listeners) listener(event, scope);
        return result;
      };
      const pending = entry.tail.then(run, run);
      entry.tail = pending.catch(() => undefined);
      return pending;
    },
  };
}
