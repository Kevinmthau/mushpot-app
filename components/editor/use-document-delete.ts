"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

import { deleteCachedDocument } from "@/lib/doc-cache";

type UseDocumentDeleteParams = {
  documentId: string;
  owner: string;
  isDeleting: boolean;
  onDeleteStart: () => void;
  onDeleteError: () => void;
};

export function useDocumentDelete({
  documentId,
  owner,
  isDeleting,
  onDeleteStart,
  onDeleteError,
}: UseDocumentDeleteParams) {
  const router = useRouter();
  const isDeletingRef = useRef(isDeleting);
  isDeletingRef.current = isDeleting;
  const onDeleteStartRef = useRef(onDeleteStart);
  onDeleteStartRef.current = onDeleteStart;
  const onDeleteErrorRef = useRef(onDeleteError);
  onDeleteErrorRef.current = onDeleteError;

  return useCallback(async () => {
    if (isDeletingRef.current) {
      return;
    }

    const isConfirmed = window.confirm(
      "Delete this document? This action cannot be undone.",
    );
    if (!isConfirmed) {
      return;
    }

    onDeleteStartRef.current();

    const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
    const supabase = await getSupabaseBrowserClient();
    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", documentId)
      .eq("owner", owner);

    if (error) {
      onDeleteErrorRef.current();
      window.alert(error.message || "Unable to delete document. Please try again.");
      return;
    }

    void deleteCachedDocument(documentId);

    router.replace("/");
  }, [documentId, owner, router]);
}
