"use client";

import { useCallback } from "react";
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

  return useCallback(async () => {
    if (isDeleting) {
      return;
    }

    const isConfirmed = window.confirm(
      "Delete this document? This action cannot be undone.",
    );
    if (!isConfirmed) {
      return;
    }

    onDeleteStart();

    const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
    const supabase = await getSupabaseBrowserClient();
    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", documentId)
      .eq("owner", owner);

    if (error) {
      onDeleteError();
      window.alert(error.message || "Unable to delete document. Please try again.");
      return;
    }

    void deleteCachedDocument(documentId);

    router.replace("/");
  }, [documentId, isDeleting, onDeleteError, onDeleteStart, owner, router]);
}
