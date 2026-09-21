import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSharedMediaUrl } from "@/lib/shared-document";

import { GET } from "./route";

vi.mock("@/lib/shared-document", () => ({
  fetchSharedMediaUrl: vi.fn(),
}));

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const SHARE_TOKEN = "a".repeat(64);

function requestMedia({
  documentId = DOCUMENT_ID,
  mediaDocumentId = DOCUMENT_ID,
}: {
  documentId?: string;
  mediaDocumentId?: string;
} = {}) {
  return GET(new Request("https://mushpot.app/shared-media"), {
    params: Promise.resolve({
      bucket: "document-images",
      id: documentId,
      path: [OWNER_ID, mediaDocumentId, "photo.png"],
      token: SHARE_TOKEN,
    }),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("shared document media route", () => {
  it("revalidates the share and redirects without caching", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    vi.mocked(fetchSharedMediaUrl).mockResolvedValue({
      status: "success",
      data: "https://project-ref.supabase.co/storage/v1/object/sign/document-images/photo.png?token=signed",
    });

    const response = await requestMedia();

    expect(fetchSharedMediaUrl).toHaveBeenCalledWith(
      DOCUMENT_ID,
      SHARE_TOKEN,
      `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/photo.png`,
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain(
      "https://project-ref.supabase.co/storage/v1/object/sign/",
    );
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
  });

  it("rejects media whose path belongs to another document", async () => {
    const sourceDocumentId = "33333333-3333-4333-8333-333333333333";
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");

    const response = await requestMedia({
      mediaDocumentId: sourceDocumentId,
    });

    expect(fetchSharedMediaUrl).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
  });

  it("returns retryable 503 for outages and 404 only for denied media", async () => {
    vi.mocked(fetchSharedMediaUrl).mockResolvedValueOnce({ status: "unavailable" });
    const outage = await requestMedia();
    expect(outage.status).toBe(503);
    expect(outage.headers.get("Retry-After")).toBe("30");
    vi.mocked(fetchSharedMediaUrl).mockResolvedValueOnce({ status: "not_found" });
    expect((await requestMedia()).status).toBe(404);
  });

  it("refuses a signed URL from an unexpected origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(fetchSharedMediaUrl).mockResolvedValue({
      status: "success", data: "https://attacker.example/document-images/photo.png",
    });

    const response = await requestMedia();

    expect(response.status).toBe(503);
  });
});
