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
import { EDITOR_DOCUMENT_SELECT, toCachedDocument } from "@/lib/documents";
import type { EditorDocument } from "@/lib/documents";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

type UseDocumentCloneParams = {
  owner: string;
  getLatestTitle: () => string;
  getLatestContent: () => string;
};

type PerformDocumentCloneParams = {
  content: string;
  leaseToken?: string;
  owner: string;
  supabase: SupabaseBrowserClient;
  title: string;
};

export const CLONE_LEASE_DURATION_MS = 10 * 60 * 1_000;
export const CLONE_HEARTBEAT_INTERVAL_MS = 60 * 1_000;

class CloneLeaseLostError extends Error {
  constructor() {
    super("The clone lease expired before the document could be completed.");
    this.name = "CloneLeaseLostError";
  }
}

function getCloneTitle(title: string) {
  return `${title} (copy)`;
}

function getTemporaryCloneTitle(title: string) {
  return `${title} (copying…)`;
}

function getCloneLeaseExpiry() {
  return new Date(Date.now() + CLONE_LEASE_DURATION_MS).toISOString();
}

async function refreshCloneLease(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
  leaseToken: string,
) {
  const { data, error } = await supabase
    .from("documents")
    .update({ clone_lease_expires_at: getCloneLeaseExpiry() })
    .eq("id", documentId)
    .eq("owner", owner)
    .eq("clone_status", "pending")
    .eq("clone_lease_token", leaseToken)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new CloneLeaseLostError();
  }
}

function startCloneLeaseHeartbeat(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
  leaseToken: string,
) {
  let leaseDeadline = Date.now() + CLONE_LEASE_DURATION_MS;
  let terminalFailure: unknown = null;
  let inFlight: Promise<void> | null = null;

  const refresh = async () => {
    if (terminalFailure) {
      throw terminalFailure;
    }

    if (!inFlight) {
      inFlight = refreshCloneLease(
        supabase,
        owner,
        documentId,
        leaseToken,
      )
        .then(() => {
          leaseDeadline = Date.now() + CLONE_LEASE_DURATION_MS;
        })
        .catch((error: unknown) => {
          if (error instanceof CloneLeaseLostError) {
            terminalFailure = error;
            throw error;
          }

          if (Date.now() >= leaseDeadline) {
            terminalFailure = new CloneLeaseLostError();
            throw terminalFailure;
          }

          // A transport/server error does not prove the CAS lease was lost.
          // Keep retrying while the last confirmed lease is conservatively
          // valid; the completion update is also guarded by status + token.
        })
        .finally(() => {
          inFlight = null;
        });
    }

    await inFlight;
  };

  const intervalId = globalThis.setInterval(() => {
    void refresh().catch(() => {
      // The foreground copy loop observes the stored failure before it can
      // complete the row. The server worker reclaims the expired lease.
    });
  }, CLONE_HEARTBEAT_INTERVAL_MS);

  return {
    refresh,
    stop() {
      globalThis.clearInterval(intervalId);
    },
  };
}

async function copyDocumentMedia(
  supabase: SupabaseBrowserClient,
  copies: DocumentMediaCopy[],
  refreshLease: () => Promise<void>,
) {
  for (const copy of copies) {
    await refreshLease();

    const { error } = await supabase.storage
      .from(copy.bucket)
      .copy(copy.sourcePath, copy.destinationPath);

    if (error) {
      throw new Error(`Unable to copy document media: ${error.message}`);
    }

    await refreshLease();
  }
}

async function removeIncompleteClone(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
  leaseToken: string,
) {
  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId)
    .eq("owner", owner)
    .eq("clone_status", "pending")
    .eq("clone_lease_token", leaseToken);

  if (error) {
    console.warn(
      "Unable to remove an incomplete clone; server maintenance will reclaim it.",
      error,
    );
  }
}

export async function performDocumentClone({
  content,
  leaseToken = crypto.randomUUID(),
  owner,
  supabase,
  title,
}: PerformDocumentCloneParams): Promise<EditorDocument> {
  let createdDocumentId: string | null = null;
  let heartbeat: ReturnType<typeof startCloneLeaseHeartbeat> | null = null;

  try {
    const { data, error } = await supabase
      .from("documents")
      .insert({
        owner,
        title: getTemporaryCloneTitle(title),
        content: "",
        clone_status: "pending",
        clone_lease_token: leaseToken,
        clone_lease_expires_at: getCloneLeaseExpiry(),
      })
      .select(EDITOR_DOCUMENT_SELECT)
      .single();

    if (error || !data) {
      throw new Error(error?.message ?? "Unable to clone document.");
    }

    createdDocumentId = data.id;
    heartbeat = startCloneLeaseHeartbeat(
      supabase,
      owner,
      data.id,
      leaseToken,
    );

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL environment variable.");
    }

    const plan = planDocumentMediaClone({
      content,
      destinationDocumentId: data.id,
      ownerId: owner,
      supabaseUrl,
    });

    if (plan.copies.length === 0) {
      await heartbeat.refresh();
    } else {
      await copyDocumentMedia(supabase, plan.copies, heartbeat.refresh);
    }

    heartbeat.stop();
    heartbeat = null;

    const { data: completedDocument, error: updateError } = await supabase
      .from("documents")
      .update({
        content: plan.content,
        title: getCloneTitle(title),
        clone_status: null,
        clone_lease_token: null,
        clone_lease_expires_at: null,
      })
      .eq("id", data.id)
      .eq("owner", owner)
      .eq("clone_status", "pending")
      .eq("clone_lease_token", leaseToken)
      .select(EDITOR_DOCUMENT_SELECT)
      .maybeSingle();

    if (updateError || !completedDocument) {
      throw new Error(
        updateError?.message ?? "Unable to finish cloning document.",
      );
    }

    createdDocumentId = null;
    return completedDocument;
  } catch (error) {
    if (createdDocumentId) {
      await removeIncompleteClone(
        supabase,
        owner,
        createdDocumentId,
        leaseToken,
      );
    }

    throw error;
  } finally {
    heartbeat?.stop();
  }
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

    try {
      const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
      const supabase = await getSupabaseBrowserClient();
      const completedDocument = await performDocumentClone({
        content: getLatestContentRef.current(),
        owner,
        supabase,
        title: getLatestTitleRef.current(),
      });

      try {
        await putCachedDocument(
          toCachedDocument(completedDocument),
          cacheWriteToken,
        );
      } catch (cacheError) {
        console.warn("Unable to cache the completed clone", cacheError);
      }

      router.push(`/doc/${completedDocument.id}`);
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Failed to clone document.",
      );
    } finally {
      isCloningRef.current = false;
      setIsCloning(false);
    }
  }, [owner, router]);

  return { isCloning, handleClone };
}
