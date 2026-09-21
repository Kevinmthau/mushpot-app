import {
  createDocumentWriteCoordinator,
  skippedDocumentWrite,
  type DocumentWriteSession,
} from "@/lib/document-write-coordinator";
import {
  getDocumentCacheWriteToken,
  getDirtyDocuments,
  putCachedDocument,
  type CachedDocument,
  type DocumentCacheWriteToken,
} from "@/lib/doc-cache";

export type PersistableDocumentSnapshot = Pick<
  CachedDocument,
  | "id"
  | "owner"
  | "title"
  | "content"
  | "share_enabled"
  | "share_token"
  | "updated_at"
  | "_localUpdatedAt"
  | "_baseVersionUntrusted"
>;

export type PersistDocumentResult = {
  status: "saved" | "retryable" | "conflict" | "cancelled" | "superseded";
  confirmedSnapshot?: PersistableDocumentSnapshot;
  cacheUpdated: boolean;
  conflict: boolean;
  ok: boolean;
  persistedTitle: string;
  updatedAt: string | null;
};

export type FlushDirtyDocumentsResult =
  | {
      attempted: number;
      remaining: number;
      status: "complete";
      succeeded: number;
    }
  | {
      attempted: 0;
      remaining: null;
      status: "unavailable";
      succeeded: 0;
    };

const SAVE_RETRY_DELAYS_MS = [1000, 2000, 4000];
const DOCUMENT_SAVE_SELECT = "share_enabled, share_token, updated_at";
const DOCUMENT_RECOVERY_SELECT =
  "title, content, share_enabled, share_token, updated_at";

type PersistedDocumentMetadata = {
  share_enabled: boolean;
  share_token: string | null;
  updated_at: string;
};

type PersistedDocumentState = PersistedDocumentMetadata & {
  content: string;
  title: string;
};

export function normalizeDocumentTitle(title: string) {
  return title.trim() || "Untitled";
}

function hasPersistedEditorState(
  document: PersistedDocumentState,
  persistedTitle: string,
  content: string,
) {
  return document.title === persistedTitle && document.content === content;
}

async function writeDocumentSnapshot(
  snapshot: PersistableDocumentSnapshot,
  cacheWriteToken: DocumentCacheWriteToken | null = getDocumentCacheWriteToken(
    snapshot.owner,
  ),
  session?: DocumentWriteSession,
): Promise<PersistDocumentResult> {
  const persistedTitle = normalizeDocumentTitle(snapshot.title);
  const cacheSnapshotAt = snapshot._localUpdatedAt ?? Date.now();
  const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
  const supabase = await getSupabaseBrowserClient();

  let lastError: unknown = null;

  for (let attempt = 0; attempt < SAVE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (!isCurrentWrite(snapshot.owner, { cacheWriteToken, session })) {
      return skippedDocumentWrite("cancelled", snapshot.title);
    }
    let updatedDocument: PersistedDocumentMetadata | null = null;
    let updateError: unknown = null;

    // Legacy dirty content has no trustworthy CAS baseline. Only read it back;
    // matching remote content can be acknowledged, divergent text needs recovery.
    if (!snapshot._baseVersionUntrusted) {
      try {
        const { data, error } = await supabase
          .from("documents")
          .update({
            title: persistedTitle,
            content: snapshot.content,
          })
          .eq("id", snapshot.id)
          .eq("owner", snapshot.owner)
          .eq("updated_at", snapshot.updated_at)
          .select(DOCUMENT_SAVE_SELECT)
          .maybeSingle();
        updatedDocument = data;
        updateError = error;
      } catch (error) {
        updateError = error;
      }
    }

    if (!isCurrentWrite(snapshot.owner, { cacheWriteToken, session })) {
      return skippedDocumentWrite("cancelled", snapshot.title);
    }

    if (!updateError && updatedDocument?.updated_at) {
      const cacheUpdated = await putCachedDocument(
        {
          ...snapshot,
          title: persistedTitle,
          updated_at: updatedDocument.updated_at,
          share_enabled: updatedDocument.share_enabled,
          share_token: updatedDocument.share_token,
          _dirty: false,
          _baseVersionUntrusted: false,
          _localUpdatedAt: cacheSnapshotAt,
        },
        cacheWriteToken,
      );

      return {
        status: "saved",
        confirmedSnapshot: {
          ...snapshot,
          _baseVersionUntrusted: false,
          title: persistedTitle,
          updated_at: updatedDocument.updated_at,
          share_enabled: updatedDocument.share_enabled,
          share_token: updatedDocument.share_token,
        },
        cacheUpdated,
        conflict: false,
        ok: true,
        persistedTitle,
        updatedAt: updatedDocument.updated_at,
      };
    }

    // A committed update can lose its response. Read the row before retrying:
    // matching editor state makes that outcome idempotent, while different
    // state is a real concurrent-write conflict that must never be overwritten.
    let currentDocument: PersistedDocumentState | null = null;
    let recoveryError: unknown = null;

    try {
      const { data, error } = await supabase
        .from("documents")
        .select(DOCUMENT_RECOVERY_SELECT)
        .eq("id", snapshot.id)
        .eq("owner", snapshot.owner)
        .maybeSingle();
      currentDocument = data;
      recoveryError = error;
    } catch (error) {
      recoveryError = error;
    }

    if (!isCurrentWrite(snapshot.owner, { cacheWriteToken, session })) {
      return skippedDocumentWrite("cancelled", snapshot.title);
    }

    if (
      !recoveryError &&
      currentDocument?.updated_at &&
      hasPersistedEditorState(currentDocument, persistedTitle, snapshot.content)
    ) {
      const cacheUpdated = await putCachedDocument(
        {
          ...snapshot,
          title: persistedTitle,
          updated_at: currentDocument.updated_at,
          share_enabled: currentDocument.share_enabled,
          share_token: currentDocument.share_token,
          _dirty: false,
          _baseVersionUntrusted: false,
          _localUpdatedAt: cacheSnapshotAt,
        },
        cacheWriteToken,
      );

      return {
        status: "saved",
        confirmedSnapshot: {
          ...snapshot,
          _baseVersionUntrusted: false,
          title: persistedTitle,
          updated_at: currentDocument.updated_at,
          share_enabled: currentDocument.share_enabled,
          share_token: currentDocument.share_token,
        },
        cacheUpdated,
        conflict: false,
        ok: true,
        persistedTitle,
        updatedAt: currentDocument.updated_at,
      };
    }

    if (!recoveryError) {
      if (
        !snapshot._baseVersionUntrusted &&
        currentDocument?.updated_at === snapshot.updated_at
      ) {
        lastError =
          updateError ??
          new Error("The document update did not return a persisted row.");
      } else {
        return {
          status: "conflict",
          cacheUpdated: false,
          conflict: true,
          ok: false,
          persistedTitle,
          updatedAt: currentDocument?.updated_at ?? null,
        };
      }
    } else {
      lastError =
        updateError ??
        recoveryError ??
        new Error("Updated document timestamp was missing.");
    }

    if (attempt < SAVE_RETRY_DELAYS_MS.length - 1) {
      await new Promise((resolve) => {
        globalThis.setTimeout(resolve, SAVE_RETRY_DELAYS_MS[attempt]);
      });
    }
  }

  console.error("persistDocumentSnapshot failed after retries", lastError);

  return {
    status: "retryable",
    cacheUpdated: false,
    conflict: false,
    ok: false,
    persistedTitle,
    updatedAt: null,
  };
}

function isCurrentWrite(
  owner: string,
  {
    cacheWriteToken,
    session,
  }: {
    cacheWriteToken: DocumentCacheWriteToken | null;
    session?: DocumentWriteSession;
  },
) {
  if (session && (!session.active || session.owner !== owner)) return false;
  const current = getDocumentCacheWriteToken(owner);
  return cacheWriteToken === null
    ? current === null
    : current?.owner === cacheWriteToken.owner &&
        current?.generation === cacheWriteToken.generation;
}

const writeCoordinator = createDocumentWriteCoordinator({
  isCurrent: isCurrentWrite,
  persist: (snapshot, { cacheWriteToken, session }) =>
    writeDocumentSnapshot(snapshot, cacheWriteToken, session),
  confirmCache: async (snapshot, result, { cacheWriteToken }) => {
    if (!result.confirmedSnapshot) return result;
    const cacheUpdated = await putCachedDocument(
      {
        ...result.confirmedSnapshot,
        _localUpdatedAt: snapshot._localUpdatedAt,
        _dirty: false,
      },
      cacheWriteToken,
    );
    return { ...result, cacheUpdated };
  },
});

export const subscribeToDocumentWrites = writeCoordinator.subscribe;

export function persistDocumentSnapshot(
  snapshot: PersistableDocumentSnapshot,
  cacheWriteToken = getDocumentCacheWriteToken(snapshot.owner),
  session?: DocumentWriteSession,
) {
  return writeCoordinator.enqueue(snapshot, { cacheWriteToken, session });
}

export async function flushDirtyDocuments(
  owner: string,
  session?: DocumentWriteSession,
): Promise<FlushDirtyDocumentsResult> {
  const cacheWriteToken = getDocumentCacheWriteToken(owner);
  if (!cacheWriteToken) {
    return {
      attempted: 0,
      remaining: null,
      status: "unavailable",
      succeeded: 0,
    } satisfies FlushDirtyDocumentsResult;
  }

  let dirtyDocuments: CachedDocument[];
  try {
    dirtyDocuments = (await getDirtyDocuments(owner, cacheWriteToken)).filter(
      (document) => document.owner === owner,
    );
  } catch (error) {
    console.error("Unable to inspect cached drafts", error);
    return {
      attempted: 0,
      remaining: null,
      status: "unavailable",
      succeeded: 0,
    } satisfies FlushDirtyDocumentsResult;
  }

  const results = await Promise.all(
    dirtyDocuments.map(async (document) => {
      try {
        return await persistDocumentSnapshot(
          document,
          cacheWriteToken,
          session,
        );
      } catch (error) {
        console.error("Unable to flush cached document", error);
        return {
          status: "retryable",
          cacheUpdated: false,
          conflict: false,
          ok: false,
          persistedTitle: normalizeDocumentTitle(document.title),
          updatedAt: null,
        } satisfies PersistDocumentResult;
      }
    }),
  );
  const succeeded = results.filter(
    (result) => result.ok && result.cacheUpdated,
  ).length;

  return {
    attempted: dirtyDocuments.length,
    remaining: dirtyDocuments.length - succeeded,
    status: "complete",
    succeeded,
  } satisfies FlushDirtyDocumentsResult;
}
