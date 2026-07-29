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
  | "_localUpdatedAt"
>;

export type PersistDocumentResult = {
  cacheUpdated: boolean;
  ok: boolean;
  persistedTitle: string;
  updatedAt: string | null;
};

export type FlushDirtyDocumentsResult = {
  attempted: number;
  remaining: number;
  succeeded: number;
};

const SAVE_RETRY_DELAYS_MS = [1000, 2000, 4000];

export function normalizeDocumentTitle(title: string) {
  return title.trim() || "Untitled";
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
    const { data, error } = await supabase
      .from("documents")
      .update({
        title: persistedTitle,
        content: snapshot.content,
      })
      .eq("id", snapshot.id)
      .eq("owner", snapshot.owner)
      .select("updated_at")
      .single();

    if (!error && data?.updated_at) {
      const updatedAt = data.updated_at;

      const cacheUpdated = await putCachedDocument(
        {
          ...snapshot,
          title: persistedTitle,
          updated_at: updatedAt,
          _dirty: false,
          _localUpdatedAt: cacheSnapshotAt,
        },
        cacheWriteToken,
      );

      return {
        cacheUpdated,
        ok: true,
        persistedTitle,
        updatedAt,
      };
    }

    lastError = error ?? new Error("Updated document timestamp was missing.");

    if (attempt < SAVE_RETRY_DELAYS_MS.length - 1) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, SAVE_RETRY_DELAYS_MS[attempt]);
      });
    }
  }

  console.error("persistDocumentSnapshot failed after retries", lastError);

  return {
    cacheUpdated: false,
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
      remaining: 0,
      succeeded: 0,
    } satisfies FlushDirtyDocumentsResult;
  }

  const dirtyDocuments = (await getDirtyDocuments(owner, cacheWriteToken)).filter(
    (document) => document.owner === owner,
  );

  const results = await Promise.all(
    dirtyDocuments.map(async (document) => {
      try {
        return await persistDocumentSnapshot(document, cacheWriteToken);
      } catch (error) {
        console.error("Unable to flush cached document", error);
        return {
          cacheUpdated: false,
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
    succeeded,
  } satisfies FlushDirtyDocumentsResult;
}
