import type { SupabaseClient } from "supabase";

const DOCUMENT_MEDIA_BUCKETS = [
  "document-images",
  "document-videos",
] as const;
const CLAIM_LIMIT = 25;
const LEASE_SECONDS = 600;
const STORAGE_PAGE_SIZE = 100;
const STORAGE_DELETE_BATCH_SIZE = 100;
const MAX_DELETE_PASSES = 100;
const MAX_RETRY_SECONDS = 24 * 60 * 60;
const CLEANUP_TOMBSTONE_MILLISECONDS = 24 * 60 * 60 * 1_000;
const CLEANUP_RESCAN_MILLISECONDS = 5 * 60 * 1_000;

export type DocumentMediaBucket = (typeof DOCUMENT_MEDIA_BUCKETS)[number];

export type CleanupJob = {
  attempt_count: number;
  created_at: string;
  document_id: string;
  job_id: string;
  lease_token: string;
  owner: string;
};

export type ExpiredClone = {
  document_id: string;
  lease_token: string;
  owner: string;
};

type ListedObject = {
  id: string | null;
  name: string;
};

export type MaintenanceOperations = {
  claimCleanupJobs: () => Promise<CleanupJob[]>;
  claimExpiredClones: () => Promise<ExpiredClone[]>;
  completeCleanupJob: (job: CleanupJob) => Promise<void>;
  deleteClaimedClone: (clone: ExpiredClone) => Promise<boolean>;
  deferCleanupJob: (job: CleanupJob, retryAt: string) => Promise<void>;
  failCleanupJob: (
    job: CleanupJob,
    error: string,
    retryAt: string,
  ) => Promise<void>;
  listObjects: (
    bucket: DocumentMediaBucket,
    prefix: string,
    offset: number,
  ) => Promise<ListedObject[]>;
  removeObjects: (
    bucket: DocumentMediaBucket,
    paths: string[],
  ) => Promise<void>;
};

type MaintenanceRequestDependencies = {
  createOperations: () => MaintenanceOperations;
  getEnvironmentValue: (name: string) => string | undefined;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^
      (rightBytes[index] ?? 0);
  }

  return mismatch === 0;
}

export function getRetryDelaySeconds(attemptCount: number) {
  const normalizedAttempt = Math.max(0, Math.floor(attemptCount));
  return Math.min(
    60 * (2 ** Math.min(normalizedAttempt, 20)),
    MAX_RETRY_SECONDS,
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown maintenance error.";
}

function joinStoragePath(prefix: string, name: string) {
  return prefix ? `${prefix}/${name}` : name;
}

async function listAllObjects(
  operations: MaintenanceOperations,
  bucket: DocumentMediaBucket,
  rootPrefix: string,
) {
  const pendingPrefixes = [rootPrefix];
  const visitedPrefixes = new Set<string>();
  const objectPaths: string[] = [];

  while (pendingPrefixes.length > 0) {
    const prefix = pendingPrefixes.shift();
    if (prefix === undefined || visitedPrefixes.has(prefix)) {
      continue;
    }
    visitedPrefixes.add(prefix);

    for (let offset = 0;; offset += STORAGE_PAGE_SIZE) {
      const entries = await operations.listObjects(bucket, prefix, offset);

      for (const entry of entries) {
        const path = joinStoragePath(prefix, entry.name);
        if (entry.id === null) {
          pendingPrefixes.push(path);
        } else {
          objectPaths.push(path);
        }
      }

      if (entries.length < STORAGE_PAGE_SIZE) {
        break;
      }
    }
  }

  return objectPaths;
}

async function deleteDocumentMedia(
  operations: MaintenanceOperations,
  bucket: DocumentMediaBucket,
  rootPrefix: string,
) {
  for (let pass = 0; pass < MAX_DELETE_PASSES; pass += 1) {
    const paths = await listAllObjects(operations, bucket, rootPrefix);
    if (paths.length === 0) {
      return;
    }

    for (
      let offset = 0;
      offset < paths.length;
      offset += STORAGE_DELETE_BATCH_SIZE
    ) {
      await operations.removeObjects(
        bucket,
        paths.slice(offset, offset + STORAGE_DELETE_BATCH_SIZE),
      );
    }
  }

  throw new Error(
    `Storage folder ${bucket}/${rootPrefix} did not become empty.`,
  );
}

export async function processCleanupJob(
  operations: MaintenanceOperations,
  job: CleanupJob,
  now = new Date(),
) {
  const rootPrefix = `${job.owner}/${job.document_id}`;

  for (const bucket of DOCUMENT_MEDIA_BUCKETS) {
    await deleteDocumentMedia(operations, bucket, rootPrefix);
  }

  for (const bucket of DOCUMENT_MEDIA_BUCKETS) {
    // Repeat the delete-until-empty pass so an object completed by a TUS
    // session between the first empty list and verification is removed without
    // being treated as an operational failure.
    await deleteDocumentMedia(operations, bucket, rootPrefix);
  }

  const tombstoneExpiresAt = new Date(job.created_at).getTime() +
    CLEANUP_TOMBSTONE_MILLISECONDS;
  if (!Number.isFinite(tombstoneExpiresAt)) {
    throw new Error("Cleanup job has an invalid creation timestamp.");
  }

  if (now.getTime() < tombstoneExpiresAt) {
    const retryAt = new Date(
      Math.min(
        now.getTime() + CLEANUP_RESCAN_MILLISECONDS,
        tombstoneExpiresAt,
      ),
    ).toISOString();
    await operations.deferCleanupJob(job, retryAt);
    return "deferred" as const;
  }

  await operations.completeCleanupJob(job);
  return "completed" as const;
}

async function runMaintenance(operations: MaintenanceOperations) {
  const claimedClones = await operations.claimExpiredClones();
  let deletedClones = 0;

  for (const clone of claimedClones) {
    try {
      if (await operations.deleteClaimedClone(clone)) {
        deletedClones += 1;
      }
    } catch (error) {
      console.error(
        "Unable to delete an expired document clone",
        clone.document_id,
        error,
      );
    }
  }

  const claimedJobs = await operations.claimCleanupJobs();
  let completedJobs = 0;
  let deferredJobs = 0;
  let failedJobs = 0;

  for (const job of claimedJobs) {
    try {
      const result = await processCleanupJob(operations, job);
      if (result === "completed") {
        completedJobs += 1;
      } else {
        deferredJobs += 1;
      }
    } catch (error) {
      failedJobs += 1;
      const retryDelay = getRetryDelaySeconds(job.attempt_count);
      const retryAt = new Date(Date.now() + retryDelay * 1_000).toISOString();

      try {
        await operations.failCleanupJob(
          job,
          getErrorMessage(error).slice(0, 2_000),
          retryAt,
        );
      } catch (failureUpdateError) {
        console.error(
          "Unable to release failed document media cleanup job",
          job.job_id,
          failureUpdateError,
        );
      }
    }
  }

  return {
    claimedClones: claimedClones.length,
    claimedJobs: claimedJobs.length,
    completedJobs,
    deferredJobs,
    deletedClones,
    failedJobs,
  };
}

export async function handleMaintenanceRequest(
  request: Request,
  dependencies: MaintenanceRequestDependencies,
) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const expectedApiKey =
    dependencies.getEnvironmentValue("SB_PUBLISHABLE_KEY") ??
      dependencies.getEnvironmentValue("SUPABASE_ANON_KEY");
  const expectedMaintenanceSecret = dependencies.getEnvironmentValue(
    "MUSHPOT_MAINTENANCE_SECRET",
  );
  const suppliedApiKey = request.headers.get("apikey") ?? "";
  const suppliedMaintenanceSecret =
    request.headers.get("x-mushpot-maintenance-secret") ?? "";

  if (!expectedApiKey || !expectedMaintenanceSecret) {
    console.error("Missing document media maintenance secrets.");
    return jsonResponse({ error: "Maintenance is not configured." }, 503);
  }

  if (
    !constantTimeEqual(suppliedApiKey, expectedApiKey) ||
    !constantTimeEqual(
      suppliedMaintenanceSecret,
      expectedMaintenanceSecret,
    )
  ) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  try {
    const result = await runMaintenance(dependencies.createOperations());
    return jsonResponse(result);
  } catch (error) {
    console.error("Document media maintenance failed", error);
    return jsonResponse({ error: "Maintenance failed." }, 500);
  }
}

export function createSupabaseMaintenanceOperations(
  client: SupabaseClient,
): MaintenanceOperations {
  return {
    async claimCleanupJobs() {
      const { data, error } = await client.rpc(
        "claim_document_media_cleanup_jobs",
        {
          p_lease_seconds: LEASE_SECONDS,
          p_limit: CLAIM_LIMIT,
        },
      );
      if (error) {
        throw new Error(`Unable to claim cleanup jobs: ${error.message}`);
      }
      return (data ?? []) as CleanupJob[];
    },

    async claimExpiredClones() {
      const { data, error } = await client.rpc(
        "claim_expired_document_clones",
        {
          p_lease_seconds: LEASE_SECONDS,
          p_limit: CLAIM_LIMIT,
        },
      );
      if (error) {
        throw new Error(`Unable to claim expired clones: ${error.message}`);
      }
      return (data ?? []) as ExpiredClone[];
    },

    async completeCleanupJob(job) {
      const { data, error } = await client
        .from("document_media_cleanup_jobs")
        .delete()
        .eq("id", job.job_id)
        .eq("lease_token", job.lease_token)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new Error(`Unable to complete cleanup job: ${error.message}`);
      }
      if (!data) {
        throw new Error("Cleanup job lease was lost before completion.");
      }
    },

    async deleteClaimedClone(clone) {
      const { data, error } = await client
        .from("documents")
        .delete()
        .eq("id", clone.document_id)
        .eq("owner", clone.owner)
        .eq("clone_status", "recovering")
        .eq("clone_lease_token", clone.lease_token)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new Error(`Unable to delete expired clone: ${error.message}`);
      }
      return Boolean(data);
    },

    async deferCleanupJob(job, retryAt) {
      const { data, error } = await client
        .from("document_media_cleanup_jobs")
        .update({
          last_error: null,
          lease_expires_at: null,
          lease_token: null,
          next_attempt_at: retryAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.job_id)
        .eq("lease_token", job.lease_token)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new Error(`Unable to defer cleanup rescan: ${error.message}`);
      }
      if (!data) {
        throw new Error("Cleanup job lease was lost before rescan scheduling.");
      }
    },

    async failCleanupJob(job, errorMessage, retryAt) {
      const { data, error } = await client
        .from("document_media_cleanup_jobs")
        .update({
          attempt_count: job.attempt_count + 1,
          last_error: errorMessage,
          lease_expires_at: null,
          lease_token: null,
          next_attempt_at: retryAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.job_id)
        .eq("lease_token", job.lease_token)
        .select("id")
        .maybeSingle();
      if (error) {
        throw new Error(`Unable to defer cleanup job: ${error.message}`);
      }
      if (!data) {
        throw new Error("Cleanup job lease was lost before retry scheduling.");
      }
    },

    async listObjects(bucket, prefix, offset) {
      const { data, error } = await client.storage.from(bucket).list(prefix, {
        limit: STORAGE_PAGE_SIZE,
        offset,
        sortBy: {
          column: "name",
          order: "asc",
        },
      });
      if (error) {
        throw new Error(
          `Unable to list ${bucket}/${prefix}: ${error.message}`,
        );
      }
      return (data ?? []).map((entry) => ({
        id: entry.id,
        name: entry.name,
      }));
    },

    async removeObjects(bucket, paths) {
      const { error } = await client.storage.from(bucket).remove(paths);
      if (error) {
        throw new Error(
          `Unable to remove objects from ${bucket}: ${error.message}`,
        );
      }
    },
  };
}
