import { describe, expect, it, vi } from "vitest";

import {
  isMissingCloneStatusColumnError,
  queryWithCloneStatusFallback,
} from "@/lib/supabase/clone-status-compat";

type TestQueryResult = {
  data: { id: string }[] | null;
  error: {
    code: string;
    details?: null;
    hint?: string | null;
    message: string;
  } | null;
};

describe("clone-status schema compatibility", () => {
  it("keeps the clone_status-filtered result on a migrated schema", async () => {
    const filteredResult: TestQueryResult = {
      data: [{ id: "document-a" }],
      error: null,
    };
    const queryWithoutCloneStatus = vi.fn(
      async (): Promise<TestQueryResult> => ({
        data: [],
        error: null,
      }),
    );

    await expect(
      queryWithCloneStatusFallback(
        async () => filteredResult,
        queryWithoutCloneStatus,
      ),
    ).resolves.toBe(filteredResult);

    expect(queryWithoutCloneStatus).not.toHaveBeenCalled();
  });

  it("retries without the filter for a 42703 clone_status error", async () => {
    const initialResult: TestQueryResult = {
      data: null,
      error: {
        code: "42703",
        details: null,
        hint: null,
        message: "column documents.clone_status does not exist",
      },
    };
    const fallbackResult: TestQueryResult = {
      data: [{ id: "document-a" }],
      error: null,
    };
    const queryWithCloneStatus = vi.fn(async () => initialResult);
    const queryWithoutCloneStatus = vi.fn(async () => fallbackResult);

    await expect(
      queryWithCloneStatusFallback(
        queryWithCloneStatus,
        queryWithoutCloneStatus,
      ),
    ).resolves.toBe(fallbackResult);

    expect(queryWithCloneStatus).toHaveBeenCalledOnce();
    expect(queryWithoutCloneStatus).toHaveBeenCalledOnce();
  });

  it.each([
    {
      code: "42703",
      message: "column documents.some_other_column does not exist",
    },
    {
      code: "PGRST204",
      message: "Could not find the clone_status column in the schema cache",
    },
    {
      code: "42501",
      message: "permission denied for column clone_status",
    },
    {
      code: "42703",
      hint: "Perhaps you meant to reference documents.clone_status",
      message: "column documents.clone_state does not exist",
    },
  ])("does not hide unrelated PostgREST errors: $code", async (error) => {
    const initialResult: TestQueryResult = { data: null, error };
    const queryWithoutCloneStatus = vi.fn(
      async (): Promise<TestQueryResult> => ({
        data: [{ id: "document-a" }],
        error: null,
      }),
    );

    await expect(
      queryWithCloneStatusFallback(
        async () => initialResult,
        queryWithoutCloneStatus,
      ),
    ).resolves.toBe(initialResult);

    expect(queryWithoutCloneStatus).not.toHaveBeenCalled();
  });

  it("requires clone_status in the 42703 message", () => {
    expect(
      isMissingCloneStatusColumnError({
        code: "42703",
        details: null,
        hint: "Perhaps you meant to reference documents.clone_status",
        message: "column documents.clone_state does not exist",
      }),
    ).toBe(false);
  });
});
