import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLONE_HEARTBEAT_INTERVAL_MS,
  CLONE_LEASE_DURATION_MS,
  performDocumentClone,
} from "@/components/editor/use-document-clone";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

vi.mock("@/lib/doc-cache", () => ({
  getDocumentCacheWriteToken: vi.fn(),
  putCachedDocument: vi.fn(),
}));

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const CLONE_DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_TOKEN = "44444444-4444-4444-8444-444444444444";

type DocumentRow = {
  clone_lease_expires_at: string | null;
  clone_lease_token: string | null;
  clone_status: "pending" | "recovering" | null;
  content: string;
  id: string;
  owner: string;
  share_enabled: boolean;
  share_token: string | null;
  title: string;
  updated_at: string;
};

type LeaseRefreshResult = "error" | "missing" | "success";

function createSupabaseMock({
  copy,
  refreshResults = [],
}: {
  copy?: (
    sourcePath: string,
    destinationPath: string,
  ) => Promise<{ error: { message: string } | null }>;
  refreshResults?: LeaseRefreshResult[];
} = {}) {
  const rows: DocumentRow[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const updateFilters: Array<Map<string, unknown>> = [];
  const deletes: Array<Map<string, unknown>> = [];
  const copyMock = vi.fn(
    copy ?? (async () => ({ error: null })),
  );
  let refreshAttempt = 0;

  function createQuery() {
    let action: "delete" | "insert" | "update" = "update";
    let values: Record<string, unknown> = {};
    const filters = new Map<string, unknown>();

    const matchingRows = () =>
      rows.filter((row) =>
        [...filters].every(
          ([column, value]) =>
            row[column as keyof DocumentRow] === value,
        ),
      );

    const execute = () => {
      if (action === "insert") {
        inserts.push(values);
        const row: DocumentRow = {
          clone_lease_expires_at:
            (values.clone_lease_expires_at as string | null) ?? null,
          clone_lease_token:
            (values.clone_lease_token as string | null) ?? null,
          clone_status:
            (values.clone_status as DocumentRow["clone_status"]) ?? null,
          content: (values.content as string) ?? "",
          id: CLONE_DOCUMENT_ID,
          owner: values.owner as string,
          share_enabled: false,
          share_token: null,
          title: (values.title as string) ?? "",
          updated_at: "2026-07-29T16:00:00.000Z",
        };
        rows.push(row);
        return { data: row, error: null };
      }

      const matches = matchingRows();
      if (action === "delete") {
        deletes.push(new Map(filters));
        for (const row of matches) {
          rows.splice(rows.indexOf(row), 1);
        }
        return { data: matches[0] ?? null, error: null };
      }

      updates.push(values);
      updateFilters.push(new Map(filters));
      const isLeaseRefresh =
        Object.keys(values).length === 1 &&
        typeof values.clone_lease_expires_at === "string";
      if (isLeaseRefresh) {
        const refreshResult =
          refreshResults[refreshAttempt] ?? "success";
        refreshAttempt += 1;

        if (refreshResult === "error") {
          return {
            data: null,
            error: { message: "temporary lease refresh failure" },
          };
        }

        if (refreshResult === "missing") {
          return { data: null, error: null };
        }
      }

      for (const row of matches) {
        Object.assign(row, values);
      }
      return { data: matches[0] ?? null, error: null };
    };

    const query = {
      delete() {
        action = "delete";
        return query;
      },
      eq(column: string, value: unknown) {
        filters.set(column, value);
        return query;
      },
      insert(insertValues: Record<string, unknown>) {
        action = "insert";
        values = insertValues;
        return query;
      },
      maybeSingle: async () => execute(),
      select() {
        return query;
      },
      single: async () => execute(),
      then<TResult1 = ReturnType<typeof execute>>(
        onFulfilled?: ((value: ReturnType<typeof execute>) => TResult1) | null,
      ) {
        return Promise.resolve(execute()).then(onFulfilled);
      },
      update(updateValues: Record<string, unknown>) {
        action = "update";
        values = updateValues;
        return query;
      },
    };

    return query;
  }

  const supabase = {
    from: vi.fn(() => createQuery()),
    storage: {
      from: vi.fn(() => ({ copy: copyMock })),
    },
  } as unknown as SupabaseBrowserClient;

  return {
    copyMock,
    deletes,
    inserts,
    rows,
    supabase,
    get refreshAttemptCount() {
      return refreshAttempt;
    },
    updateFilters,
    updates,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("performDocumentClone", () => {
  it("binds completion to a ten-minute lease token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T16:00:00.000Z"));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    const { inserts, rows, supabase, updateFilters, updates } =
      createSupabaseMock();

    const completed = await performDocumentClone({
      content: "No media",
      leaseToken: LEASE_TOKEN,
      owner: OWNER_ID,
      supabase,
      title: "Notes",
    });

    expect(completed).toMatchObject({
      clone_lease_expires_at: null,
      clone_lease_token: null,
      clone_status: null,
      content: "No media",
      title: "Notes (copy)",
    });
    expect(updates[0]).toEqual({
      clone_lease_expires_at: new Date(
        Date.now() + CLONE_LEASE_DURATION_MS,
      ).toISOString(),
    });
    expect(inserts[0]).toMatchObject({
      clone_lease_expires_at: new Date(
        Date.now() + CLONE_LEASE_DURATION_MS,
      ).toISOString(),
      clone_lease_token: LEASE_TOKEN,
      clone_status: "pending",
    });
    expect(Object.fromEntries(updateFilters.at(-1) ?? [])).toMatchObject({
      clone_lease_token: LEASE_TOKEN,
      clone_status: "pending",
      id: CLONE_DOCUMENT_ID,
      owner: OWNER_ID,
    });
    expect(rows).toHaveLength(1);
  });

  it("refreshes the lease every minute while a media copy is in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T16:00:00.000Z"));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    let finishCopy: ((value: { error: null }) => void) | undefined;
    const copy = vi.fn(
      () =>
        new Promise<{ error: null }>((resolve) => {
          finishCopy = resolve;
        }),
    );
    const { copyMock, supabase, updates } = createSupabaseMock({ copy });

    const clonePromise = performDocumentClone({
      content:
        `![photo](/m/document-images/${OWNER_ID}/` +
        `${SOURCE_DOCUMENT_ID}/photo.png)`,
      leaseToken: LEASE_TOKEN,
      owner: OWNER_ID,
      supabase,
      title: "Photos",
    });

    await vi.waitFor(() => expect(copyMock).toHaveBeenCalledOnce());
    const updatesBeforeInterval = updates.length;
    await vi.advanceTimersByTimeAsync(CLONE_HEARTBEAT_INTERVAL_MS);

    expect(updates.length).toBeGreaterThan(updatesBeforeInterval);

    finishCopy?.({ error: null });
    await expect(clonePromise).resolves.toMatchObject({
      clone_status: null,
      title: "Photos (copy)",
    });
  });

  it("retries transient heartbeat errors while the confirmed lease remains valid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T16:00:00.000Z"));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    let finishCopy: ((value: { error: null }) => void) | undefined;
    const copy = vi.fn(
      () =>
        new Promise<{ error: null }>((resolve) => {
          finishCopy = resolve;
        }),
    );
    const mock = createSupabaseMock({
      copy,
      refreshResults: ["success", "error", "success"],
    });

    const clonePromise = performDocumentClone({
      content:
        `![photo](/m/document-images/${OWNER_ID}/` +
        `${SOURCE_DOCUMENT_ID}/photo.png)`,
      leaseToken: LEASE_TOKEN,
      owner: OWNER_ID,
      supabase: mock.supabase,
      title: "Photos",
    });

    await vi.waitFor(() => expect(mock.copyMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(CLONE_HEARTBEAT_INTERVAL_MS * 2);
    expect(mock.refreshAttemptCount).toBeGreaterThanOrEqual(3);

    finishCopy?.({ error: null });
    await expect(clonePromise).resolves.toMatchObject({
      clone_status: null,
      title: "Photos (copy)",
    });
  });

  it("treats a token/status miss as terminal lease loss", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    const { deletes, rows, supabase } = createSupabaseMock({
      refreshResults: ["missing"],
    });

    await expect(
      performDocumentClone({
        content: "No media",
        leaseToken: LEASE_TOKEN,
        owner: OWNER_ID,
        supabase,
        title: "Notes",
      }),
    ).rejects.toThrow("clone lease expired");

    expect(rows).toEqual([]);
    expect(deletes).toHaveLength(1);
  });

  it("stops retrying transient errors when the last confirmed lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T16:00:00.000Z"));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    let finishCopy: ((value: { error: null }) => void) | undefined;
    const copy = vi.fn(
      () =>
        new Promise<{ error: null }>((resolve) => {
          finishCopy = resolve;
        }),
    );
    const mock = createSupabaseMock({
      copy,
      refreshResults: [
        "success",
        ...Array.from({ length: 10 }, () => "error" as const),
      ],
    });

    const clonePromise = performDocumentClone({
      content:
        `![photo](/m/document-images/${OWNER_ID}/` +
        `${SOURCE_DOCUMENT_ID}/photo.png)`,
      leaseToken: LEASE_TOKEN,
      owner: OWNER_ID,
      supabase: mock.supabase,
      title: "Photos",
    });

    await vi.waitFor(() => expect(mock.copyMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(CLONE_LEASE_DURATION_MS);
    finishCopy?.({ error: null });

    await expect(clonePromise).rejects.toThrow("clone lease expired");
    expect(mock.rows).toEqual([]);
  });

  it("deletes a failed pending clone by status and lease token", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    const { deletes, rows, supabase } = createSupabaseMock({
      copy: async () => ({ error: { message: "copy unavailable" } }),
    });

    await expect(
      performDocumentClone({
        content:
          `![photo](/m/document-images/${OWNER_ID}/` +
          `${SOURCE_DOCUMENT_ID}/photo.png)`,
        leaseToken: LEASE_TOKEN,
        owner: OWNER_ID,
        supabase,
        title: "Photos",
      }),
    ).rejects.toThrow("Unable to copy document media");

    expect(rows).toEqual([]);
    expect(deletes).toHaveLength(1);
    expect(Object.fromEntries(deletes[0])).toMatchObject({
      clone_lease_token: LEASE_TOKEN,
      clone_status: "pending",
      id: CLONE_DOCUMENT_ID,
      owner: OWNER_ID,
    });
  });
});
