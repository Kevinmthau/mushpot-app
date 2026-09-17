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
    purgeExpiredBackfillSnapshots: () => Promise.resolve(0),
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
    expiredSnapshotsDeleted: 0,
    failedJobs: 0,
  });
});

Deno.test("maintenance reports expired snapshots deleted by the worker", async () => {
  const response = await handleMaintenanceRequest(
    new Request("https://example.test", {
      method: "POST",
      headers: {
        apikey: "publishable",
        "x-mushpot-maintenance-secret": "maintenance",
      },
    }),
    {
      createOperations: () =>
        createOperations({
          purgeExpiredBackfillSnapshots: () => Promise.resolve(3),
        }),
      getEnvironmentValue: (name) =>
        name === "SUPABASE_ANON_KEY"
          ? "publishable"
          : name === "MUSHPOT_MAINTENANCE_SECRET"
          ? "maintenance"
          : undefined,
    },
  );

  assertEquals(response.status, 200);
  assertEquals(
    (await response.json()).expiredSnapshotsDeleted,
    3,
  );
});

Deno.test("maintenance fails visibly when snapshot expiry cannot run", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await handleMaintenanceRequest(
      new Request("https://example.test", {
        method: "POST",
        headers: {
          apikey: "publishable",
          "x-mushpot-maintenance-secret": "maintenance",
        },
      }),
      {
        createOperations: () =>
          createOperations({
            purgeExpiredBackfillSnapshots: () =>
              Promise.reject(new Error("database unavailable")),
          }),
        getEnvironmentValue: (name) =>
          name === "SUPABASE_ANON_KEY"
            ? "publishable"
            : name === "MUSHPOT_MAINTENANCE_SECRET"
            ? "maintenance"
            : undefined,
      },
    );

    assertEquals(response.status, 500);
    assertEquals(await response.json(), {
      error: "Maintenance failed.",
    });
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("maintenance deletes a claimed expired clone", async () => {
  const clone = {
    document_id: "55555555-5555-4555-8555-555555555555",
    lease_token: "66666666-6666-4666-8666-666666666666",
    owner: "11111111-1111-4111-8111-111111111111",
  };
  let deletedCloneId = "";
  const response = await handleMaintenanceRequest(
    new Request("https://example.test", {
      method: "POST",
      headers: {
        apikey: "publishable",
        "x-mushpot-maintenance-secret": "maintenance",
      },
    }),
    {
      createOperations: () =>
        createOperations({
          claimExpiredClones: () => Promise.resolve([clone]),
          deleteClaimedClone: (claimedClone) => {
            deletedCloneId = claimedClone.document_id;
            return Promise.resolve(true);
          },
        }),
      getEnvironmentValue: (name) =>
        name === "SUPABASE_ANON_KEY"
          ? "publishable"
          : name === "MUSHPOT_MAINTENANCE_SECRET"
          ? "maintenance"
          : undefined,
    },
  );

  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.claimedClones, 1);
  assertEquals(result.deletedClones, 1);
  assertEquals(deletedCloneId, clone.document_id);
});

Deno.test("maintenance schedules retry after cleanup failure", async () => {
  let completed = false;
  let retriedJobId = "";
  let retryAt = "";
  const response = await handleMaintenanceRequest(
    new Request("https://example.test", {
      method: "POST",
      headers: {
        apikey: "publishable",
        "x-mushpot-maintenance-secret": "maintenance",
      },
    }),
    {
      now: () => new Date("2026-07-29T11:00:00.000Z"),
      createOperations: () =>
        createOperations({
          claimCleanupJobs: () => Promise.resolve([CLEANUP_JOB]),
          completeCleanupJob: () => {
            completed = true;
            return Promise.resolve();
          },
          failCleanupJob: (job, _error, scheduledAt) => {
            retriedJobId = job.job_id;
            retryAt = scheduledAt;
            return Promise.resolve();
          },
          listObjects: (bucket) =>
            Promise.resolve(
              bucket === "document-images"
                ? [{ id: "image-id", name: "cover.png" }]
                : [],
            ),
          removeObjects: () =>
            Promise.reject(new Error("temporary Storage failure")),
        }),
      getEnvironmentValue: (name) =>
        name === "SUPABASE_ANON_KEY"
          ? "publishable"
          : name === "MUSHPOT_MAINTENANCE_SECRET"
          ? "maintenance"
          : undefined,
    },
  );

  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.failedJobs, 1);
  assertEquals(result.completedJobs, 0);
  assertEquals(retriedJobId, CLEANUP_JOB.job_id);
  // At age 23 hours, a successful scan would wait until expiry. A first
  // operational failure still becomes eligible for retry in one minute.
  assertEquals(retryAt, "2026-07-29T11:01:00.000Z");
  assertEquals(completed, false);
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

  await processCleanupJob(
    operations,
    CLEANUP_JOB,
    new Date("2026-07-29T12:00:00.000Z"),
  );

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
  assertEquals(deferredUntil, "2026-07-29T12:05:00.000Z");
  assertEquals(completed, false);
});

Deno.test("empty cleanup scans back off and finish with a pass at expiry", async () => {
  const createdAt = new Date(CLEANUP_JOB.created_at).getTime();
  const scanAges: number[] = [];
  let nextScanAt = new Date(createdAt);
  let listCount = 0;
  let completed = false;
  const operations = createOperations({
    listObjects: () => {
      listCount += 1;
      return Promise.resolve([]);
    },
    deferCleanupJob: (_job, retryAt) => {
      const scheduledAt = new Date(retryAt);
      assertEquals(scheduledAt > nextScanAt, true);
      nextScanAt = scheduledAt;
      return Promise.resolve();
    },
    completeCleanupJob: () => {
      assertEquals(nextScanAt.getTime() - createdAt, 24 * 60 * 60 * 1_000);
      completed = true;
      return Promise.resolve();
    },
  });

  for (let attempt = 0; attempt < 20 && !completed; attempt += 1) {
    scanAges.push((nextScanAt.getTime() - createdAt) / 60_000);
    const result = await processCleanupJob(operations, CLEANUP_JOB, nextScanAt);
    assertEquals(result, completed ? "completed" : "deferred");
  }

  assertEquals(completed, true);
  assertEquals(scanAges, [
    0,
    5,
    15,
    30,
    60,
    120,
    240,
    480,
    720,
    960,
    1_200,
    1_440,
  ]);
  // Both buckets are checked twice per pass, including the final expiry pass.
  assertEquals(listCount, 48);
});

Deno.test("cleanup skips missed scans without using the failure retry count", async () => {
  let deferredUntil = "";
  const result = await processCleanupJob(
    createOperations({
      deferCleanupJob: (_job, retryAt) => {
        deferredUntil = retryAt;
        return Promise.resolve();
      },
    }),
    { ...CLEANUP_JOB, attempt_count: 100 },
    new Date("2026-07-28T13:40:00.000Z"),
  );

  assertEquals(result, "deferred");
  assertEquals(deferredUntil, "2026-07-28T14:00:00.000Z");
});

Deno.test("later cleanup scans remove uploads arriving between passes and before expiry", async () => {
  const root = `${CLEANUP_JOB.owner}/${CLEANUP_JOB.document_id}`;
  const pendingObjects = new Set<string>();
  const removedPaths: string[] = [];
  let completed = false;
  const operations = createOperations({
    listObjects: (bucket) =>
      Promise.resolve(
        bucket === "document-videos"
          ? Array.from(pendingObjects, (name) => ({ id: name, name }))
          : [],
      ),
    removeObjects: (bucket, paths) => {
      assertEquals(bucket, "document-videos");
      for (const path of paths) {
        removedPaths.push(path);
        pendingObjects.delete(path.slice(root.length + 1));
      }
      return Promise.resolve();
    },
    completeCleanupJob: () => {
      assertEquals(pendingObjects.size, 0);
      completed = true;
      return Promise.resolve();
    },
  });

  await processCleanupJob(
    operations,
    CLEANUP_JOB,
    new Date("2026-07-28T12:05:00.000Z"),
  );
  pendingObjects.add("resumed-at-12-06.mp4");
  assertEquals(
    await processCleanupJob(
      operations,
      CLEANUP_JOB,
      new Date("2026-07-28T12:15:00.000Z"),
    ),
    "deferred",
  );
  assertEquals(pendingObjects.size, 0);
  assertEquals(completed, false);

  await processCleanupJob(
    operations,
    CLEANUP_JOB,
    new Date("2026-07-29T08:00:00.000Z"),
  );
  pendingObjects.add("resumed-just-before-expiry.mp4");
  assertEquals(
    await processCleanupJob(
      operations,
      CLEANUP_JOB,
      new Date("2026-07-29T12:00:00.000Z"),
    ),
    "completed",
  );
  assertEquals(completed, true);
  assertEquals(removedPaths, [
    `${root}/resumed-at-12-06.mp4`,
    `${root}/resumed-just-before-expiry.mp4`,
  ]);
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
    await processCleanupJob(
      operations,
      CLEANUP_JOB,
      new Date("2026-07-29T12:00:00.000Z"),
    );
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
