import { afterEach, describe, expect, it, vi } from "vitest";

import { recoverInterruptedDocumentClones } from "@/lib/document-maintenance";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const STALE_PENDING_ID = "22222222-2222-4222-8222-222222222222";
const FRESH_PENDING_ID = "33333333-3333-4333-8333-333333333333";
const RECOVERING_ID = "44444444-4444-4444-8444-444444444444";

type CloneRow = {
  clone_status: "pending" | "recovering";
  id: string;
  owner: string;
  updated_at: string;
};

function createSupabaseMock(documents: CloneRow[]) {
  const rows = [...documents];
  const removedPaths: string[][] = [];

  function createDocumentsQuery() {
    let action: "delete" | "select" | "update" = "select";
    let updateValues: Partial<CloneRow> = {};
    const equalityFilters = new Map<string, string>();
    const lessThanFilters = new Map<string, string>();
    let resultLimit = Number.POSITIVE_INFINITY;

    const matchingRows = () =>
      rows.filter(
        (row) =>
          [...equalityFilters].every(
            ([column, value]) => row[column as keyof CloneRow] === value,
          ) &&
          [...lessThanFilters].every(
            ([column, value]) => row[column as keyof CloneRow] < value,
          ),
      );

    const execute = () => {
      const matches = matchingRows().slice(0, resultLimit);

      if (action === "update") {
        for (const row of matches) {
          Object.assign(row, updateValues);
        }
      } else if (action === "delete") {
        for (const row of matches) {
          rows.splice(rows.indexOf(row), 1);
        }
      }

      return {
        data: action === "delete" ? null : matches.map(({ id }) => ({ id })),
        error: null,
      };
    };

    const query = {
      delete() {
        action = "delete";
        return query;
      },
      eq(column: string, value: string) {
        equalityFilters.set(column, value);
        return query;
      },
      limit(value: number) {
        resultLimit = value;
        return query;
      },
      lt(column: string, value: string) {
        lessThanFilters.set(column, value);
        return query;
      },
      maybeSingle: async () => {
        const result = execute();
        return { ...result, data: result.data?.[0] ?? null };
      },
      order() {
        return query;
      },
      select() {
        return query;
      },
      then<TResult1 = ReturnType<typeof execute>>(
        onFulfilled?: ((value: ReturnType<typeof execute>) => TResult1) | null,
      ) {
        return Promise.resolve(execute()).then(onFulfilled);
      },
      update(values: Partial<CloneRow>) {
        action = "update";
        updateValues = values;
        return query;
      },
    };

    return query;
  }

  const supabase = {
    from: vi.fn(() => createDocumentsQuery()),
    storage: {
      from: vi.fn(() => ({
        list: vi.fn(async () => ({ data: [], error: null })),
        remove: vi.fn(async (paths: string[]) => {
          removedPaths.push(paths);
          return { error: null };
        }),
      })),
    },
  } as unknown as SupabaseBrowserClient;

  return { removedPaths, rows, supabase };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("recoverInterruptedDocumentClones", () => {
  it("removes stale and previously claimed clones but leaves fresh clones alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T18:00:00.000Z"));
    const { rows, supabase } = createSupabaseMock([
      {
        clone_status: "pending",
        id: STALE_PENDING_ID,
        owner: OWNER_ID,
        updated_at: "2026-07-17T17:00:00.000Z",
      },
      {
        clone_status: "pending",
        id: FRESH_PENDING_ID,
        owner: OWNER_ID,
        updated_at: "2026-07-17T17:55:00.000Z",
      },
      {
        clone_status: "recovering",
        id: RECOVERING_ID,
        owner: OWNER_ID,
        updated_at: "2026-07-17T17:59:00.000Z",
      },
    ]);

    await recoverInterruptedDocumentClones(supabase, OWNER_ID);

    expect(rows).toEqual([
      expect.objectContaining({
        clone_status: "pending",
        id: FRESH_PENDING_ID,
      }),
    ]);
  });
});
