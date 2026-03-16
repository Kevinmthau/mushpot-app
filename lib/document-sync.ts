import {
  getDirtyDocuments,
  putCachedDocument,
  type CachedDocument,
} from "@/lib/doc-cache";
import type { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type PersistableDocumentSnapshot = Pick<
  CachedDocument,
  "id" | "owner" | "title" | "content" | "share_enabled" | "share_token"
>;

export type PersistDocumentResult = {
  ok: boolean;
  persistedTitle: string;
  updatedAt: string | null;
};

const SAVE_RETRY_DELAYS_MS = [1000, 2000, 4000];

let supabaseClientPromise: Promise<ReturnType<typeof createSupabaseBrowserClient>> | null =
  null;

export async function getSupabaseBrowserClient() {
  if (!supabaseClientPromise) {
    supabaseClientPromise = import("@/lib/supabase/client").then((module) =>
      module.createSupabaseBrowserClient(),
    );
  }

  return supabaseClientPromise;
}

export function normalizeDocumentTitle(title: string) {
  return title.trim() || "Untitled";
}

export async function persistDocumentSnapshot(
  snapshot: PersistableDocumentSnapshot,
): Promise<PersistDocumentResult> {
  const persistedTitle = normalizeDocumentTitle(snapshot.title);
  const supabase = await getSupabaseBrowserClient();

  let lastError: unknown = null;

  for (let attempt = 0; attempt < SAVE_RETRY_DELAYS_MS.length; attempt += 1) {
    const { error } = await supabase
      .from("documents")
      .update({
        title: persistedTitle,
        content: snapshot.content,
      })
      .eq("id", snapshot.id)
      .eq("owner", snapshot.owner);

    if (!error) {
      const updatedAt = new Date().toISOString();

      void putCachedDocument({
        ...snapshot,
        title: persistedTitle,
        updated_at: updatedAt,
        _dirty: false,
        _localUpdatedAt: Date.now(),
      });

      return {
        ok: true,
        persistedTitle,
        updatedAt,
      };
    }

    lastError = error;

    if (attempt < SAVE_RETRY_DELAYS_MS.length - 1) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, SAVE_RETRY_DELAYS_MS[attempt]);
      });
    }
  }

  console.error("persistDocumentSnapshot failed after retries", lastError);

  return {
    ok: false,
    persistedTitle,
    updatedAt: null,
  };
}

export async function flushDirtyDocuments() {
  const dirtyDocuments = await getDirtyDocuments();

  for (const document of dirtyDocuments) {
    await persistDocumentSnapshot(document);
  }
}
