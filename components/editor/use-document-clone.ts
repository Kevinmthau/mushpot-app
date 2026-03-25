"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { type CachedDocument, putCachedDocument } from "@/lib/doc-cache";

type UseDocumentCloneParams = {
  documentId: string;
  owner: string;
  getLatestTitle: () => string;
  getLatestContent: () => string;
};

export function useDocumentClone({
  owner,
  getLatestTitle,
  getLatestContent,
}: UseDocumentCloneParams) {
  const router = useRouter();
  const [isCloning, setIsCloning] = useState(false);

  const handleClone = useCallback(async () => {
    if (isCloning) return;
    setIsCloning(true);

    try {
      const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
      const supabase = await getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("documents")
        .insert({
          owner,
          title: `${getLatestTitle()} (copy)`,
          content: getLatestContent(),
        })
        .select("id, owner, title, content, updated_at, share_enabled, share_token")
        .single();

      if (error || !data) {
        throw new Error(error?.message ?? "Unable to clone document.");
      }

      const cachedDocument: CachedDocument = {
        id: data.id,
        owner: data.owner,
        title: data.title,
        content: data.content,
        updated_at: data.updated_at,
        share_enabled: data.share_enabled,
        share_token: data.share_token,
        _dirty: false,
      };
      await putCachedDocument(cachedDocument);

      router.push(`/doc/${data.id}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to clone document.");
    } finally {
      setIsCloning(false);
    }
  }, [isCloning, owner, getLatestTitle, getLatestContent, router]);

  return { isCloning, handleClone };
}
