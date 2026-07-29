// Kept as `_test.ts` so Deno runs it without Vitest collecting it.
import { assertEquals } from "@std/assert";

import {
  type CleanupJob,
  getRetryDelaySeconds,
  handleMaintenanceRequest,
  type MaintenanceOperations,
  processCleanupJob,
} from "./maintenance.ts";

const CLEANUP_JOB: CleanupJob = {
  attempt_count: 0,
  created_at: "2026-07-28T12:00:00.000Z",
  document_id: "22222222-2222-4222-8222-222222222222",
  job_id: "33333333-3333-4333-8333-333333333333",
  lease_token: "44444444-4444-4444-8444-444444444444",
  owner: "11111111-1111-4111-8111-111111111111",
};

function createOperations(
  overrides: Partial<MaintenanceOperations> = {},
): MaintenanceOperations {
  return {
    claimCleanupJobs: () => Promise.resolve([]),
    claimExpiredClones: () => Promise.resolve([]),
    completeCleanupJob: () => Promise.resolve(),
    deleteClaimedClone: () => Promise.resolve(false),
    deferCleanupJob: () => Promise.resolve(),
    failCleanupJob: () => Promise.resolve(),
    listObjects: () => Promise.resolve([]),
    removeObjects: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("maintenance rejects missing or incorrect secrets", async () => {
  let createdOperations = false;
  const dependencies = {
    createOperations: () => {
      createdOperations = true;
      return createOperations();
    },
    getEnvironmentValue: (name: string) =>
      name === "SUPABASE_ANON_KEY"
        ? "publishable"
        : name === "MUSHPOT_MAINTENANCE_SECRET"
        ? "maintenance"
        : undefined,
  };

  const unauthorizedHeaders: HeadersInit[] = [
    {},
    {
      apikey: "wrong",
      "x-mushpot-maintenance-secret": "maintenance",
    },
    {
      apikey: "publishable",
      "x-mushpot-maintenance-secret": "wrong",
    },
  ];

  for (const headers of unauthorizedHeaders) {
    const response = await handleMaintenanceRequest(
      new Request("https://example.test", {
        method: "POST",
        headers,
      }),
      dependencies,
    );
    assertEquals(response.status, 401);
  }

  assertEquals(createdOperations, false);
});

Deno.test("maintenance accepts both secrets and runs claimed work", async () => {
  const response = await handleMaintenanceRequest(
    new Request("https://example.test", {
      method: "POST",
      headers: {
        apikey: "publishable",
        "x-mushpot-maintenance-secret": "maintenance",
      },
    }),
    {
      createOperations: () => createOperations(),
      getEnvironmentValue: (name) =>
        name === "SB_PUBLISHABLE_KEY"
          ? "publishable"
          : name === "MUSHPOT_MAINTENANCE_SECRET"
          ? "maintenance"
          : undefined,
    },
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    claimedClones: 0,
    claimedJobs: 0,
    completedJobs: 0,
    deferredJobs: 0,
    deletedClones: 0,
    failedJobs: 0,
  });
});

Deno.test("cleanup recursively deletes, re-lists, then completes", async () => {
  const calls: string[] = [];
  let imageRootListings = 0;
  const root = `${CLEANUP_JOB.owner}/${CLEANUP_JOB.document_id}`;
  const operations = createOperations({
    completeCleanupJob: () => {
      calls.push("complete");
      return Promise.resolve();
    },
    listObjects: (bucket, prefix) => {
      calls.push(`list:${bucket}:${prefix}`);
      if (bucket === "document-images" && prefix === root) {
        imageRootListings += 1;
        return Promise.resolve(
          imageRootListings === 1
            ? [
              { id: "image-id", name: "cover.png" },
              { id: null, name: "nested" },
            ]
            : [],
        );
      }
      if (bucket === "document-images" && prefix === `${root}/nested`) {
        return Promise.resolve(
          imageRootListings === 1
            ? [{ id: "poster-id", name: "poster.png" }]
            : [],
        );
      }
      return Promise.resolve([]);
    },
    removeObjects: (bucket, paths) => {
      calls.push(`remove:${bucket}:${paths.join(",")}`);
      return Promise.resolve();
    },
  });

  await processCleanupJob(operations, CLEANUP_JOB);

  assertEquals(
    calls.some((call) =>
      call ===
        `remove:document-images:${root}/cover.png,${root}/nested/poster.png`
    ),
    true,
  );
  assertEquals(calls.at(-1), "complete");
});

Deno.test("cleanup defers empty tombstones during the TUS grace window", async () => {
  let completed = false;
  let deferredUntil = "";
  const job = {
    ...CLEANUP_JOB,
    created_at: "2026-07-29T12:00:00.000Z",
  };
  const operations = createOperations({
    completeCleanupJob: () => {
      completed = true;
      return Promise.resolve();
    },
    deferCleanupJob: (_job, retryAt) => {
      deferredUntil = retryAt;
      return Promise.resolve();
    },
  });

  const result = await processCleanupJob(
    operations,
    job,
    new Date("2026-07-29T12:01:00.000Z"),
  );

  assertEquals(result, "deferred");
  assertEquals(deferredUntil, "2026-07-29T12:06:00.000Z");
  assertEquals(completed, false);
});

Deno.test("late TUS object is removed and tombstone remains scheduled", async () => {
  const root = `${CLEANUP_JOB.owner}/${CLEANUP_JOB.document_id}`;
  let imageListings = 0;
  let removedLateObject = false;
  let deferred = false;
  let completed = false;
  const job = {
    ...CLEANUP_JOB,
    created_at: "2026-07-29T12:00:00.000Z",
  };
  const operations = createOperations({
    completeCleanupJob: () => {
      completed = true;
      return Promise.resolve();
    },
    deferCleanupJob: () => {
      deferred = true;
      return Promise.resolve();
    },
    listObjects: (bucket) => {
      if (bucket !== "document-images") {
        return Promise.resolve([]);
      }
      imageListings += 1;
      return Promise.resolve(
        imageListings === 2
          ? [{ id: "late-tus-object", name: "late-upload.png" }]
          : [],
      );
    },
    removeObjects: (_bucket, paths) => {
      removedLateObject = paths.includes(`${root}/late-upload.png`);
      return Promise.resolve();
    },
  });

  const result = await processCleanupJob(
    operations,
    job,
    new Date("2026-07-29T12:01:00.000Z"),
  );

  assertEquals(result, "deferred");
  assertEquals(removedLateObject, true);
  assertEquals(deferred, true);
  assertEquals(completed, false);
});

Deno.test("cleanup never completes when deletion fails", async () => {
  let completed = false;
  const operations = createOperations({
    completeCleanupJob: () => {
      completed = true;
      return Promise.resolve();
    },
    listObjects: (bucket) =>
      Promise.resolve(
        bucket === "document-images"
          ? [{ id: "image-id", name: "cover.png" }]
          : [],
      ),
    removeObjects: () => Promise.reject(new Error("partial failure")),
  });

  let message = "";
  try {
    await processCleanupJob(operations, CLEANUP_JOB);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }

  assertEquals(message, "partial failure");
  assertEquals(completed, false);
});

Deno.test("retry delay uses capped exponential backoff", () => {
  assertEquals(getRetryDelaySeconds(0), 60);
  assertEquals(getRetryDelaySeconds(1), 120);
  assertEquals(getRetryDelaySeconds(5), 1_920);
  assertEquals(getRetryDelaySeconds(100), 86_400);
});
