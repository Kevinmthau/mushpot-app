import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteDocumentWithMediaCleanup } from "@/components/editor/use-document-delete";
import {
  DOCUMENT_IMAGE_BUCKET,
  DOCUMENT_VIDEO_BUCKET,
  type DocumentMediaBucket,
} from "@/lib/document-media";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

vi.mock("@/lib/doc-cache", () => ({
  deleteCachedDocument: vi.fn(),
}));

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

type MockSetup = {
  deleteData?: string | null;
  deleteError?: { message: string } | null;
  imageListError?: { message: string } | null;
  referenceError?: { message: string } | null;
  referencingDocuments?: Array<{
    id: string;
    title: string;
    content: string;
  }>;
};

function createSupabaseMock({
  deleteData = DOCUMENT_ID,
  deleteError = null,
  imageListError = null,
  referenceError = null,
  referencingDocuments = [],
}: MockSetup = {}) {
  const events: string[] = [];
  const imageRemove = vi.fn(
    async (): Promise<{ error: { message: string } | null }> => ({ error: null }),
  );
  const videoRemove = vi.fn(
    async (): Promise<{ error: { message: string } | null }> => ({ error: null }),
  );
  const listData: Record<DocumentMediaBucket, { name: string; id: string }[]> = {
    [DOCUMENT_IMAGE_BUCKET]: [{ name: "photo.png", id: "image-object" }],
    [DOCUMENT_VIDEO_BUCKET]: [],
  };

  const storageFrom = vi.fn((bucket: DocumentMediaBucket) => ({
    list: vi.fn(async () => {
      events.push(`list:${bucket}`);
      return {
        data: listData[bucket],
        error: bucket === DOCUMENT_IMAGE_BUCKET ? imageListError : null,
      };
    }),
    remove: bucket === DOCUMENT_IMAGE_BUCKET ? imageRemove : videoRemove,
  }));

  const rpc = vi.fn(async () => {
    events.push("delete:document");
    return { data: deleteData, error: deleteError };
  });
  const completeJob = vi.fn(async () => {
    events.push("complete:cleanup-job");
    return { error: null };
  });
  const completeJobOwnerEq = vi.fn(() => ({ eq: completeJob }));
  const deleteCleanupJob = vi.fn(() => ({ eq: completeJobOwnerEq }));
  const referenceLike = vi.fn(async () => {
    events.push("inspect:references");
    return { data: referencingDocuments, error: referenceError };
  });
  const referenceNeq = vi.fn(() => ({ like: referenceLike }));
  const referenceEq = vi.fn(() => ({ neq: referenceNeq }));
  const referenceSelect = vi.fn(() => ({ eq: referenceEq }));
  const from = vi.fn((table: string) =>
    table === "document_media_cleanup_jobs"
      ? { delete: deleteCleanupJob }
      : { select: referenceSelect },
  );

  imageRemove.mockImplementation(async () => {
    events.push(`remove:${DOCUMENT_IMAGE_BUCKET}`);
    return { error: null };
  });
  videoRemove.mockImplementation(async () => {
    events.push(`remove:${DOCUMENT_VIDEO_BUCKET}`);
    return { error: null };
  });

  return {
    events,
    imageRemove,
    videoRemove,
    rpc,
    supabase: {
      storage: { from: storageFrom },
      from,
      rpc,
    } as unknown as SupabaseBrowserClient,
  };
}

describe("deleteDocumentWithMediaCleanup", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists media, deletes the document row, then removes the listed objects", async () => {
    const { events, imageRemove, supabase } = createSupabaseMock();

    const result = await deleteDocumentWithMediaCleanup(
      supabase,
      OWNER_ID,
      DOCUMENT_ID,
    );

    expect(result.cleanupError).toBeNull();
    expect(imageRemove).toHaveBeenCalledWith([
      `${OWNER_ID}/${DOCUMENT_ID}/photo.png`,
    ]);
    expect(events.indexOf(`list:${DOCUMENT_IMAGE_BUCKET}`)).toBeGreaterThan(
      events.indexOf("inspect:references"),
    );
    expect(events.indexOf("delete:document")).toBeGreaterThan(
      events.indexOf(`list:${DOCUMENT_IMAGE_BUCKET}`),
    );
    expect(events.indexOf(`remove:${DOCUMENT_IMAGE_BUCKET}`)).toBeGreaterThan(
      events.indexOf("delete:document"),
    );
    expect(events.indexOf("complete:cleanup-job")).toBeGreaterThan(
      events.indexOf(`remove:${DOCUMENT_IMAGE_BUCKET}`),
    );
  });

  it("does not remove media when deleting the document row fails", async () => {
    const { imageRemove, supabase } = createSupabaseMock({
      deleteError: { message: "database unavailable" },
    });

    await expect(
      deleteDocumentWithMediaCleanup(supabase, OWNER_ID, DOCUMENT_ID),
    ).rejects.toThrow("database unavailable");
    expect(imageRemove).not.toHaveBeenCalled();
  });

  it("does not report success when row-level security deletes no document", async () => {
    const { imageRemove, supabase } = createSupabaseMock({
      deleteData: null,
    });

    await expect(
      deleteDocumentWithMediaCleanup(supabase, OWNER_ID, DOCUMENT_ID),
    ).rejects.toThrow("The document was not deleted");
    expect(imageRemove).not.toHaveBeenCalled();
  });

  it("retries a failed cleanup after the document has been deleted", async () => {
    const { events, imageRemove, supabase } = createSupabaseMock();
    const wait = vi.fn(async () => undefined);
    imageRemove
      .mockImplementationOnce(async () => {
        events.push(`remove:${DOCUMENT_IMAGE_BUCKET}`);
        return { error: { message: "temporary storage failure" } };
      })
      .mockImplementationOnce(async () => {
        events.push(`remove:${DOCUMENT_IMAGE_BUCKET}`);
        return { error: null };
      });

    const result = await deleteDocumentWithMediaCleanup(
      supabase,
      OWNER_ID,
      DOCUMENT_ID,
      { attempts: 3, retryDelayMs: 10, wait },
    );

    expect(result.cleanupError).toBeNull();
    expect(imageRemove).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(10);
    expect(events.indexOf(`remove:${DOCUMENT_IMAGE_BUCKET}`)).toBeGreaterThan(
      events.indexOf("delete:document"),
    );
  });

  it("reports exhausted cleanup retries without turning deletion into an error", async () => {
    const { events, imageRemove, supabase } = createSupabaseMock();
    imageRemove.mockImplementation(async () => {
      events.push(`remove:${DOCUMENT_IMAGE_BUCKET}`);
      return { error: { message: "storage unavailable" } };
    });

    const result = await deleteDocumentWithMediaCleanup(
      supabase,
      OWNER_ID,
      DOCUMENT_ID,
      { attempts: 2, retryDelayMs: 0, wait: vi.fn(async () => undefined) },
    );

    expect(result.cleanupError?.message).toContain(
      "Unable to remove 1 private media object after 2 attempts",
    );
    expect(imageRemove).toHaveBeenCalledTimes(2);
    expect(events).not.toContain("complete:cleanup-job");
  });

  it("leaves the document untouched when media cannot be listed", async () => {
    const { rpc, imageRemove, supabase } = createSupabaseMock({
      imageListError: { message: "listing unavailable" },
    });

    await expect(
      deleteDocumentWithMediaCleanup(supabase, OWNER_ID, DOCUMENT_ID),
    ).rejects.toThrow("The document was not deleted");
    expect(rpc).not.toHaveBeenCalled();
    expect(imageRemove).not.toHaveBeenCalled();
  });

  it("leaves the document and media untouched while another document references its media", async () => {
    const { rpc, imageRemove, supabase, events } = createSupabaseMock({
      referencingDocuments: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          title: "Legacy clone",
          content: `![photo](/m/${DOCUMENT_IMAGE_BUCKET}/${OWNER_ID}/${DOCUMENT_ID}/photo.png)`,
        },
      ],
    });

    await expect(
      deleteDocumentWithMediaCleanup(supabase, OWNER_ID, DOCUMENT_ID),
    ).rejects.toThrow('still used by “Legacy clone”');
    expect(events).toEqual(["inspect:references"]);
    expect(rpc).not.toHaveBeenCalled();
    expect(imageRemove).not.toHaveBeenCalled();
  });

  it("leaves the document untouched when dependent documents cannot be inspected", async () => {
    const { rpc, imageRemove, supabase } = createSupabaseMock({
      referenceError: { message: "database unavailable" },
    });

    await expect(
      deleteDocumentWithMediaCleanup(supabase, OWNER_ID, DOCUMENT_ID),
    ).rejects.toThrow("Unable to inspect dependent documents");
    expect(rpc).not.toHaveBeenCalled();
    expect(imageRemove).not.toHaveBeenCalled();
  });
});
