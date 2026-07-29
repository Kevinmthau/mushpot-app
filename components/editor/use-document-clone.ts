"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  getDocumentCacheWriteToken,
  putCachedDocument,
} from "@/lib/doc-cache";
import {
  planDocumentMediaClone,
  type DocumentMediaCopy,
} from "@/lib/document-media-clone";
import type { DocumentMediaBucket } from "@/lib/document-media";
import { EDITOR_DOCUMENT_SELECT, toCachedDocument } from "@/lib/documents";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

type UseDocumentCloneParams = {
  owner: string;
  getLatestTitle: () => string;
  getLatestContent: () => string;
};

const STORAGE_DELETE_BATCH_SIZE = 100;

function getCloneTitle(title: string) {
  return `${title} (copy)`;
}

function getTemporaryCloneTitle(title: string) {
  return `${title} (copying…)`;
}

function getFailedCloneTitle(title: string) {
  return `${title} (clone failed)`;
}

async function copyDocumentMedia(
  supabase: SupabaseBrowserClient,
  copies: DocumentMediaCopy[],
) {
  for (const copy of copies) {
    const { error } = await supabase.storage
      .from(copy.bucket)
      .copy(copy.sourcePath, copy.destinationPath);

    if (error) {
      throw new Error(`Unable to copy document media: ${error.message}`);
    }
  }
}

async function removePlannedDocumentMedia(
  supabase: SupabaseBrowserClient,
  copies: DocumentMediaCopy[],
) {
  const pathsByBucket = new Map<DocumentMediaBucket, string[]>();

  for (const copy of copies) {
    const paths = pathsByBucket.get(copy.bucket) ?? [];
    paths.push(copy.destinationPath);
    pathsByBucket.set(copy.bucket, paths);
  }

  const failures: string[] = [];
  for (const [bucket, paths] of pathsByBucket) {
    for (let index = 0; index < paths.length; index += STORAGE_DELETE_BATCH_SIZE) {
      const { error } = await supabase.storage
        .from(bucket)
        .remove(paths.slice(index, index + STORAGE_DELETE_BATCH_SIZE));

      if (error) {
        failures.push(`${bucket}: ${error.message}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

async function markCloneFailed(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
  title: string,
) {
  const { error } = await supabase
    .from("documents")
    .update({
      clone_status: null,
      content:
        "This document was created by a clone operation that did not complete. Delete it and try cloning again.",
      title: getFailedCloneTitle(title),
    })
    .eq("id", documentId)
    .eq("owner", owner);

  if (error) {
    console.error("Unable to label an incomplete clone", error);
  }
}

async function rollbackClone(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
  title: string,
  copies: DocumentMediaCopy[],
) {
  try {
    // Remove copied objects first so a successful rollback does not leave
    // private orphans behind after the temporary row is deleted.
    await removePlannedDocumentMedia(supabase, copies);
  } catch (error) {
    console.error("Unable to fully clean up cloned media", error);
    await markCloneFailed(supabase, owner, documentId, title);
    return false;
  }

  const { data, error } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId)
    .eq("owner", owner)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error("Unable to remove an incomplete clone", error);
    }
    await markCloneFailed(supabase, owner, documentId, title);
    return false;
  }

  return true;
}

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
    const cacheWriteToken = getDocumentCacheWriteToken(owner);

    let createdDocumentId: string | null = null;
    let plannedCopies: DocumentMediaCopy[] = [];
    let supabaseClient: SupabaseBrowserClient | null = null;
    let title = "";

    try {
      const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
      const supabase = await getSupabaseBrowserClient();
      supabaseClient = supabase;
      title = getLatestTitleRef.current();
      const sourceContent = getLatestContentRef.current();
      const { data, error } = await supabase
        .from("documents")
        .insert({
          owner,
          title: getTemporaryCloneTitle(title),
          content: "",
          clone_status: "pending",
        })
        .select(EDITOR_DOCUMENT_SELECT)
        .single();

      if (error || !data) {
        throw new Error(error?.message ?? "Unable to clone document.");
      }

      createdDocumentId = data.id;
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (!supabaseUrl) {
        throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL environment variable.");
      }

      const plan = planDocumentMediaClone({
        content: sourceContent,
        destinationDocumentId: data.id,
        ownerId: owner,
        supabaseUrl,
      });
      plannedCopies = plan.copies;

      await copyDocumentMedia(supabase, plan.copies);

      const { data: completedDocument, error: updateError } = await supabase
        .from("documents")
        .update({
          content: plan.content,
          title: getCloneTitle(title),
          clone_status: null,
        })
        .eq("id", data.id)
        .eq("owner", owner)
        .eq("clone_status", "pending")
        .select(EDITOR_DOCUMENT_SELECT)
        .single();

      if (updateError || !completedDocument) {
        throw new Error(updateError?.message ?? "Unable to finish cloning document.");
      }

      await putCachedDocument(
        toCachedDocument(completedDocument),
        cacheWriteToken,
      );

      createdDocumentId = null;
      router.push(`/doc/${data.id}`);
    } catch (err) {
      let incompleteCloneWasKept = false;

      if (createdDocumentId && supabaseClient) {
        try {
          incompleteCloneWasKept = !(await rollbackClone(
            supabaseClient,
            owner,
            createdDocumentId,
            title,
            plannedCopies,
          ));
        } catch (cleanupError) {
          console.error("Unable to roll back an incomplete clone", cleanupError);
          try {
            await markCloneFailed(
              supabaseClient,
              owner,
              createdDocumentId,
              title,
            );
          } catch (labelError) {
            console.error("Unable to label an incomplete clone", labelError);
          }
          incompleteCloneWasKept = true;
        }
      }

      const message =
        err instanceof Error ? err.message : "Failed to clone document.";
      window.alert(
        incompleteCloneWasKept
          ? `${message} An incomplete document may have been kept with a failure label so its media can be deleted safely.`
          : message,
      );
    } finally {
      isCloningRef.current = false;
      setIsCloning(false);
    }
  }, [owner, router]);

  return { isCloning, handleClone };
}
