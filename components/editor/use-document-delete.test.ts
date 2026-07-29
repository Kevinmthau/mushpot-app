import { describe, expect, it, vi } from "vitest";

import {
  deleteDocument,
  deleteDocumentAndCache,
} from "@/components/editor/use-document-delete";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

vi.mock("@/lib/doc-cache", () => ({
  deleteCachedDocument: vi.fn(),
}));

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

function createSupabaseMock({
  data = { id: DOCUMENT_ID },
  error = null,
}: {
  data?: { id: string } | null;
  error?: { message: string } | null;
} = {}) {
  const maybeSingle = vi.fn(async () => ({ data, error }));
  const select = vi.fn(() => ({ maybeSingle }));
  const ownerEq = vi.fn(() => ({ select }));
  const idEq = vi.fn(() => ({ eq: ownerEq }));
  const deleteRow = vi.fn(() => ({ eq: idEq }));
  const from = vi.fn(() => ({ delete: deleteRow }));

  return {
    deleteRow,
    from,
    idEq,
    ownerEq,
    select,
    supabase: { from } as unknown as SupabaseBrowserClient,
  };
}

describe("deleteDocument", () => {
  it("deletes only the owned row and leaves media cleanup to the database", async () => {
    const { deleteRow, from, idEq, ownerEq, select, supabase } =
      createSupabaseMock();

    await expect(
      deleteDocument(supabase, OWNER_ID, DOCUMENT_ID),
    ).resolves.toBeUndefined();

    expect(from).toHaveBeenCalledWith("documents");
    expect(deleteRow).toHaveBeenCalledOnce();
    expect(idEq).toHaveBeenCalledWith("id", DOCUMENT_ID);
    expect(ownerEq).toHaveBeenCalledWith("owner", OWNER_ID);
    expect(select).toHaveBeenCalledWith("id");
  });

  it("does not report success when RLS deletes no row", async () => {
    const { supabase } = createSupabaseMock({ data: null });

    await expect(
      deleteDocument(supabase, OWNER_ID, DOCUMENT_ID),
    ).rejects.toThrow("The document was not deleted");
  });

  it("surfaces the database error", async () => {
    const { supabase } = createSupabaseMock({
      data: null,
      error: { message: "document writes are temporarily frozen" },
    });

    await expect(
      deleteDocument(supabase, OWNER_ID, DOCUMENT_ID),
    ).rejects.toThrow("document writes are temporarily frozen");
  });
});

describe("deleteDocumentAndCache", () => {
  it("surfaces client acquisition failures before touching the cache", async () => {
    const deleteCached = vi.fn(async () => true);

    await expect(
      deleteDocumentAndCache(OWNER_ID, DOCUMENT_ID, {
        deleteCachedDocument: deleteCached,
        getSupabaseClient: async () => {
          throw new Error("client import failed");
        },
      }),
    ).rejects.toThrow("client import failed");

    expect(deleteCached).not.toHaveBeenCalled();
  });

  it("awaits the cache tombstone after the server delete", async () => {
    const { supabase } = createSupabaseMock();
    let finishCacheDelete: (() => void) | undefined;
    const deleteCached = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCacheDelete = () => resolve(true);
        }),
    );
    let settled = false;

    const deletion = deleteDocumentAndCache(OWNER_ID, DOCUMENT_ID, {
      deleteCachedDocument: deleteCached,
      getSupabaseClient: async () => supabase,
    }).then(() => {
      settled = true;
    });

    await vi.waitFor(() =>
      expect(deleteCached).toHaveBeenCalledWith(DOCUMENT_ID, OWNER_ID)
    );
    expect(settled).toBe(false);

    finishCacheDelete?.();
    await deletion;
    expect(settled).toBe(true);
  });
});
