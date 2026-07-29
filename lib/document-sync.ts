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
>;

export type PersistDocumentResult = {
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
const DOCUMENT_SAVE_SELECT =
  "title, content, share_enabled, share_token, updated_at";

type PersistedDocumentState = {
  content: string;
  share_enabled: boolean;
  share_token: string | null;
  title: string;
  updated_at: string;
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

export async function persistDocumentSnapshot(
  snapshot: PersistableDocumentSnapshot,
  cacheWriteToken: DocumentCacheWriteToken | null =
    getDocumentCacheWriteToken(snapshot.owner),
): Promise<PersistDocumentResult> {
  const persistedTitle = normalizeDocumentTitle(snapshot.title);
  const cacheSnapshotAt = snapshot._localUpdatedAt ?? Date.now();
  const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
  const supabase = await getSupabaseBrowserClient();

  let lastError: unknown = null;

  for (let attempt = 0; attempt < SAVE_RETRY_DELAYS_MS.length; attempt += 1) {
    let updatedDocument: PersistedDocumentState | null = null;
    let updateError: unknown = null;

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

    if (!updateError && updatedDocument?.updated_at) {
      const cacheUpdated = await putCachedDocument(
        {
          ...snapshot,
          title: persistedTitle,
          updated_at: updatedDocument.updated_at,
          share_enabled: updatedDocument.share_enabled,
          share_token: updatedDocument.share_token,
          _dirty: false,
          _localUpdatedAt: cacheSnapshotAt,
        },
        cacheWriteToken,
      );

      return {
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
        .select(DOCUMENT_SAVE_SELECT)
        .eq("id", snapshot.id)
        .eq("owner", snapshot.owner)
        .maybeSingle();
      currentDocument = data;
      recoveryError = error;
    } catch (error) {
      recoveryError = error;
    }

    if (
      !recoveryError &&
      currentDocument?.updated_at &&
      hasPersistedEditorState(
        currentDocument,
        persistedTitle,
        snapshot.content,
      )
    ) {
      const cacheUpdated = await putCachedDocument(
        {
          ...snapshot,
          title: persistedTitle,
          updated_at: currentDocument.updated_at,
          share_enabled: currentDocument.share_enabled,
          share_token: currentDocument.share_token,
          _dirty: false,
          _localUpdatedAt: cacheSnapshotAt,
        },
        cacheWriteToken,
      );

      return {
        cacheUpdated,
        conflict: false,
        ok: true,
        persistedTitle,
        updatedAt: currentDocument.updated_at,
      };
    }

    if (!recoveryError) {
      if (currentDocument?.updated_at === snapshot.updated_at) {
        lastError =
          updateError ??
          new Error("The document update did not return a persisted row.");
      } else {
        return {
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
        window.setTimeout(resolve, SAVE_RETRY_DELAYS_MS[attempt]);
      });
    }
  }

  console.error("persistDocumentSnapshot failed after retries", lastError);

  return {
    cacheUpdated: false,
    conflict: false,
    ok: false,
    persistedTitle,
    updatedAt: null,
  };
}

export async function flushDirtyDocuments(
  owner: string,
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
    dirtyDocuments = (
      await getDirtyDocuments(owner, cacheWriteToken)
    ).filter((document) => document.owner === owner);
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
        return await persistDocumentSnapshot(document, cacheWriteToken);
      } catch (error) {
        console.error("Unable to flush cached document", error);
        return {
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
