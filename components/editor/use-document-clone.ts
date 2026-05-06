"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { putCachedDocument } from "@/lib/doc-cache";
import { EDITOR_DOCUMENT_SELECT, toCachedDocument } from "@/lib/documents";

type UseDocumentCloneParams = {
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
  const isCloningRef = useRef(false);
  const getLatestTitleRef = useRef(getLatestTitle);
  getLatestTitleRef.current = getLatestTitle;
  const getLatestContentRef = useRef(getLatestContent);
  getLatestContentRef.current = getLatestContent;

  const handleClone = useCallback(async () => {
    if (isCloningRef.current) return;
    isCloningRef.current = true;
    setIsCloning(true);

    try {
      const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
      const supabase = await getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("documents")
        .insert({
          owner,
          title: `${getLatestTitleRef.current()} (copy)`,
          content: getLatestContentRef.current(),
        })
        .select(EDITOR_DOCUMENT_SELECT)
        .single();

      if (error || !data) {
        throw new Error(error?.message ?? "Unable to clone document.");
      }

      await putCachedDocument(toCachedDocument(data));

      router.push(`/doc/${data.id}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to clone document.");
    } finally {
      isCloningRef.current = false;
      setIsCloning(false);
    }
  }, [owner, router]);

  return { isCloning, handleClone };
}
