import {
  cleanupDocumentMediaWithRetry,
  listDocumentMedia,
  type ListedDocumentMedia,
  type MediaCleanupRetryOptions,
} from "@/lib/document-media-cleanup";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

const MAINTENANCE_BATCH_SIZE = 25;
const STALE_CLONE_GRACE_MS = 15 * 60 * 1_000;

export async function finishDocumentMediaCleanupJob(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
  listedMedia?: ListedDocumentMedia[],
  retryOptions?: MediaCleanupRetryOptions,
): Promise<Error | null> {
  let media = listedMedia;

  try {
    media ??= await listDocumentMedia(supabase, owner, documentId);
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error("Unable to inspect queued document media.");
  }

  const cleanupError = await cleanupDocumentMediaWithRetry(
    supabase,
    media,
    retryOptions,
  );
  if (cleanupError) {
    return cleanupError;
  }

  const { error: jobDeleteError } = await supabase
    .from("document_media_cleanup_jobs")
    .delete()
    .eq("document_id", documentId)
    .eq("owner", owner);

  return jobDeleteError
    ? new Error(`Unable to complete media cleanup: ${jobDeleteError.message}`)
    : null;
}

async function processDocumentMediaCleanupJobs(
  supabase: SupabaseBrowserClient,
  owner: string,
) {
  const { data, error } = await supabase
    .from("document_media_cleanup_jobs")
    .select("document_id")
    .eq("owner", owner)
    .order("created_at", { ascending: true })
    .limit(MAINTENANCE_BATCH_SIZE);

  if (error) {
    throw new Error(`Unable to load media cleanup jobs: ${error.message}`);
  }

  for (const job of data ?? []) {
    await finishDocumentMediaCleanupJob(supabase, owner, job.document_id);
  }
}

async function removeClaimedClone(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
) {
  const listedMedia = await listDocumentMedia(supabase, owner, documentId);
  const cleanupError = await cleanupDocumentMediaWithRetry(
    supabase,
    listedMedia,
  );
  if (cleanupError) {
    return;
  }

  await supabase
    .from("documents")
    .delete()
    .eq("id", documentId)
    .eq("owner", owner)
    .eq("clone_status", "recovering");
}

export async function recoverInterruptedDocumentClones(
  supabase: SupabaseBrowserClient,
  owner: string,
) {
  const staleBefore = new Date(Date.now() - STALE_CLONE_GRACE_MS).toISOString();
  const [{ data: recovering, error: recoveringError }, { data: pending, error: pendingError }] =
    await Promise.all([
      supabase
        .from("documents")
        .select("id")
        .eq("owner", owner)
        .eq("clone_status", "recovering")
        .limit(MAINTENANCE_BATCH_SIZE),
      supabase
        .from("documents")
        .select("id")
        .eq("owner", owner)
        .eq("clone_status", "pending")
        .lt("updated_at", staleBefore)
        .order("updated_at", { ascending: true })
        .limit(MAINTENANCE_BATCH_SIZE),
    ]);

  if (recoveringError || pendingError) {
    throw new Error(
      `Unable to load interrupted clones: ${recoveringError?.message ?? pendingError?.message}`,
    );
  }

  for (const clone of recovering ?? []) {
    await removeClaimedClone(supabase, owner, clone.id);
  }

  for (const clone of pending ?? []) {
    const { data: claimedClone, error: claimError } = await supabase
      .from("documents")
      .update({ clone_status: "recovering" })
      .eq("id", clone.id)
      .eq("owner", owner)
      .eq("clone_status", "pending")
      .select("id")
      .maybeSingle();

    if (!claimError && claimedClone) {
      await removeClaimedClone(supabase, owner, clone.id);
    }
  }
}

export async function runDocumentMaintenance(owner: string) {
  const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
  const supabase = await getSupabaseBrowserClient();

  const results = await Promise.allSettled([
    processDocumentMediaCleanupJobs(supabase, owner),
    recoverInterruptedDocumentClones(supabase, owner),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("Deferred document maintenance failed", result.reason);
    }
  }
}
