"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

import { deleteCachedDocument } from "@/lib/doc-cache";
import {
  documentContentReferencesMediaFromDocument,
} from "@/lib/document-media";
import {
  listDocumentMedia,
  type ListedDocumentMedia,
  type MediaCleanupRetryOptions,
} from "@/lib/document-media-cleanup";
import { finishDocumentMediaCleanupJob } from "@/lib/document-maintenance";
import { getDocumentDisplayTitle } from "@/lib/documents";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

type UseDocumentDeleteParams = {
  documentId: string;
  owner: string;
  isDeleting: boolean;
  onDeleteStart: () => void;
  onDeleteError: () => void;
};

type ReferencingDocument = {
  id: string;
  title: string;
};

async function findDocumentsReferencingDocumentMedia(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
): Promise<ReferencingDocument[]> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL environment variable.");
  }

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, content")
    .eq("owner", owner)
    .neq("id", documentId)
    .like("content", `%${documentId}%`);

  if (error) {
    throw new Error(`Unable to inspect document references: ${error.message}`);
  }

  return (data ?? [])
    .filter((document) =>
      documentContentReferencesMediaFromDocument(
        document.content,
        owner,
        documentId,
        supabaseUrl,
      ),
    )
    .map(({ id, title }) => ({ id, title }));
}

function getDependentMediaError(referencingDocuments: ReferencingDocument[]) {
  const titles = referencingDocuments
    .slice(0, 3)
    .map((document) => `“${getDocumentDisplayTitle(document.title)}”`);
  const remainingCount = referencingDocuments.length - titles.length;
  const documentList =
    remainingCount > 0
      ? `${titles.join(", ")}, and ${remainingCount} more`
      : titles.join(", ");

  return new Error(
    `This document cannot be deleted because its media is still used by ${documentList}. Remove or replace those embeds first.`,
  );
}

export async function deleteDocumentWithMediaCleanup(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
  retryOptions?: MediaCleanupRetryOptions,
): Promise<{ cleanupError: Error | null }> {
  let referencingDocuments: ReferencingDocument[];
  let listedMedia: ListedDocumentMedia[];

  try {
    referencingDocuments = await findDocumentsReferencingDocumentMedia(
      supabase,
      owner,
      documentId,
    );
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `Unable to inspect dependent documents. The document was not deleted.${reason}`,
    );
  }

  if (referencingDocuments.length > 0) {
    throw getDependentMediaError(referencingDocuments);
  }

  try {
    listedMedia = await listDocumentMedia(supabase, owner, documentId);
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `Unable to inspect document media. The document was not deleted.${reason}`,
    );
  }

  const { data: deletedDocumentId, error } = await supabase.rpc(
    "delete_document_with_media_cleanup_job",
    { p_document_id: documentId },
  );

  if (error || !deletedDocumentId) {
    throw new Error(
      error?.message ||
        "The document was not deleted. It may have already been removed or the session may have changed.",
    );
  }

  return {
    cleanupError: await finishDocumentMediaCleanupJob(
      supabase,
      owner,
      documentId,
      listedMedia,
      retryOptions,
    ),
  };
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

    let cleanupError: Error | null;

    try {
      ({ cleanupError } = await deleteDocumentWithMediaCleanup(
        supabase,
        owner,
        documentId,
      ));
    } catch (error) {
      onDeleteErrorRef.current();
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to delete document. Please try again.",
      );
      return;
    }

    void deleteCachedDocument(documentId);

    router.replace("/");

    if (cleanupError) {
      console.warn("Document media cleanup failed after deletion", cleanupError);
      window.alert(
        "The document was deleted, but some private media still needs cleanup. The app will retry automatically while you are signed in.",
      );
    }
  }, [documentId, owner, router]);
}
