"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

import { deleteCachedDocument } from "@/lib/doc-cache";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

type UseDocumentDeleteParams = {
  documentId: string;
  owner: string;
  isDeleting: boolean;
  onDeleteStart: () => void;
  onDeleteError: () => void;
};

export async function deleteDocument(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
) {
  const { data, error } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId)
    .eq("owner", owner)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    throw new Error(
      error?.message ||
        "The document was not deleted. It may have already been removed or the session may have changed.",
    );
  }
}

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

    try {
      await deleteDocument(supabase, owner, documentId);
    } catch (error) {
      onDeleteErrorRef.current();
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to delete document. Please try again.",
      );
      return;
    }

    void deleteCachedDocument(documentId, owner);
    router.replace("/");
  }, [documentId, owner, router]);
}
