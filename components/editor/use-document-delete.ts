"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";

import { deleteCachedDocument } from "@/lib/doc-cache";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

type UseDocumentDeleteParams = {
  documentId: string;
  owner: string;
  isDeleting: boolean;
  onDeleteStart: () => void;
  onDeleteError: () => void;
  onServerDelete?: () => void;
};

type DeleteDocumentAndCacheDependencies = {
  onServerDelete?: () => void;
  deleteCachedDocument?: (
    documentId: string,
    owner: string,
  ) => Promise<boolean>;
  getSupabaseClient?: () => Promise<SupabaseBrowserClient>;
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

export async function deleteDocumentAndCache(
  owner: string,
  documentId: string,
  {
    deleteCachedDocument: deleteCached = deleteCachedDocument,
    onServerDelete,
    getSupabaseClient = async () => {
      const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
      return getSupabaseBrowserClient();
    },
  }: DeleteDocumentAndCacheDependencies = {},
) {
  const supabase = await getSupabaseClient();
  await deleteDocument(supabase, owner, documentId);
  onServerDelete?.();
  await deleteCached(documentId, owner);
}

export function useDocumentDelete({
  documentId,
  owner,
  isDeleting,
  onDeleteStart,
  onDeleteError,
  onServerDelete,
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

    try {
      await deleteDocumentAndCache(owner, documentId, {
        onServerDelete,
      });
    } catch (error) {
      onDeleteError();
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to delete document. Please try again.",
      );
      return;
    }

    router.replace("/");
  }, [
    documentId,
    isDeleting,
    onDeleteError,
    onDeleteStart,
    onServerDelete,
    owner,
    router,
  ]);
}
