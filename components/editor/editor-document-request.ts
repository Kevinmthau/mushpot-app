import {
  canReuseDocumentResponse,
  getDocumentCacheWriteToken,
  type DocumentCacheWriteToken,
} from "@/lib/doc-cache";
import type { DocumentWriteSession } from "@/lib/document-write-coordinator";
import { EDITOR_DOCUMENT_SELECT, type EditorDocument } from "@/lib/documents";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { queryWithCloneStatusFallback } from "@/lib/supabase/clone-status-compat";

export type EditorRemoteResult =
  | { document: EditorDocument; error: null }
  | { document: null; error: string | null };

const LOAD_ERROR = "Unable to load document. Please check your connection.";
const WARM_TTL_MS = 5000;
const MAX_WARM_DOCUMENTS = 3;
const MAX_WARM_REQUESTS = 2;

type RequestEntry = {
  promise: Promise<EditorRemoteResult>;
  startedAt: number;
  token: DocumentCacheWriteToken | null;
  warm: boolean;
};

type RequestDependencies = {
  canReuse: (
    id: string,
    token: DocumentCacheWriteToken,
    updatedAt: string,
    startedAt: number,
  ) => Promise<boolean>;
  getToken: (owner: string) => DocumentCacheWriteToken | null;
  now?: () => number;
  query: (id: string, owner: string) => Promise<EditorRemoteResult>;
};

/** Read-only warmup. Cache publication remains owned by useEditorDocument. */
export function createEditorDocumentRequests({
  canReuse,
  getToken,
  now = Date.now,
  query,
}: RequestDependencies) {
  const sessions = new WeakMap<DocumentWriteSession, {
    entries: Map<string, RequestEntry>;
    inFlight: number;
    warmStarts: number[];
  }>();

  const stateFor = (session: DocumentWriteSession) => {
    let state = sessions.get(session);
    if (!state) {
      state = { entries: new Map(), inFlight: 0, warmStarts: [] };
      sessions.set(session, state);
    }
    return state;
  };

  const isCurrent = (session: DocumentWriteSession, entry: RequestEntry) => {
    const current = getToken(session.owner);
    return session.active &&
      (!entry.token || current?.generation === entry.token.generation);
  };

  const start = (id: string, session: DocumentWriteSession, warm: boolean) => {
    const state = stateFor(session);
    const entry: RequestEntry = {
      promise: Promise.resolve({ document: null, error: LOAD_ERROR }),
      startedAt: now(),
      token: getToken(session.owner),
      warm,
    };
    state.inFlight += 1;
    entry.promise = (async () => {
      try {
        const result = await query(id, session.owner);
        return isCurrent(session, entry)
          ? result
          : { document: null, error: LOAD_ERROR };
      } catch {
        return { document: null, error: LOAD_ERROR };
      } finally {
        state.inFlight -= 1;
      }
    })();
    state.entries.set(id, entry);
    void entry.promise.then((result) => {
      if (state.entries.get(id) !== entry) return;
      if (!warm || !result.document || now() - entry.startedAt >= WARM_TTL_MS) {
        state.entries.delete(id);
      }
    });
    return entry;
  };

  return {
    warm(id: string, session: DocumentWriteSession) {
      if (!session.active || !getToken(session.owner)) return false;
      const state = stateFor(session);
      state.warmStarts = state.warmStarts.filter((time) => now() - time < WARM_TTL_MS);
      for (const [key, entry] of state.entries) {
        if (!isCurrent(session, entry) || now() - entry.startedAt >= WARM_TTL_MS) {
          state.entries.delete(key);
        }
      }
      if (
        state.entries.has(id) ||
        state.inFlight >= MAX_WARM_REQUESTS ||
        state.warmStarts.length >= MAX_WARM_DOCUMENTS
      ) return false;
      state.warmStarts.push(now());
      start(id, session, true);
      return true;
    },
    async load(id: string, session: DocumentWriteSession): Promise<EditorRemoteResult> {
      if (!session.active) return { document: null, error: LOAD_ERROR };
      const state = stateFor(session);
      const existing = state.entries.get(id);
      if (existing && isCurrent(session, existing)) {
        if (!existing.warm) return existing.promise;
        if (now() - existing.startedAt < WARM_TTL_MS) {
          const result = await existing.promise;
          const reusable = result.document && existing.token &&
            now() - existing.startedAt < WARM_TTL_MS &&
            await canReuse(id, existing.token, result.document.updated_at, existing.startedAt);
          // Validation can itself await IndexedDB while sign-out/expiry occurs.
          if (reusable && isCurrent(session, existing) &&
            now() - existing.startedAt < WARM_TTL_MS) {
            if (state.entries.get(id) === existing) state.entries.delete(id);
            return result;
          }
        }
      }
      if (!session.active) return { document: null, error: LOAD_ERROR };
      // Another consumer may already have replaced an invalid warm request.
      const fresh = state.entries.get(id);
      if (fresh && !fresh.warm && isCurrent(session, fresh)) return fresh.promise;
      return start(id, session, false).promise;
    },
  };
}

async function queryEditorDocument(id: string, owner: string): Promise<EditorRemoteResult> {
  const supabase = await getSupabaseBrowserClient();
  const { data, error } = await queryWithCloneStatusFallback(
    () => supabase.from("documents").select(EDITOR_DOCUMENT_SELECT)
      .eq("id", id).eq("owner", owner).is("clone_status", null).maybeSingle(),
    () => supabase.from("documents").select(EDITOR_DOCUMENT_SELECT)
      .eq("id", id).eq("owner", owner).maybeSingle(),
  );
  return error ? { document: null, error: error.message } : { document: data, error: null };
}

const requests = createEditorDocumentRequests({
  canReuse: canReuseDocumentResponse,
  getToken: getDocumentCacheWriteToken,
  query: queryEditorDocument,
});

export const warmEditorDocument = requests.warm;
export const loadRemoteEditorDocument = requests.load;
