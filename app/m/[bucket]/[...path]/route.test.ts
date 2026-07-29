import { afterEach, describe, expect, it, vi } from "vitest";

import { createSupabaseServerClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

function createSupabaseMock({
  sourceDocumentExists = true,
  signedUrl =
    "https://project-ref.supabase.co/storage/v1/object/sign/document-images/photo.png?token=signed",
  userId = OWNER_ID,
}: {
  sourceDocumentExists?: boolean;
  signedUrl?: string;
  userId?: string | null;
} = {}) {
  const createSignedUrl = vi.fn(async () => ({
    data: signedUrl ? { signedUrl } : null,
    error: signedUrl ? null : { message: "not found" },
  }));
  const maybeSingle = vi.fn(async () => ({
    data: sourceDocumentExists ? { id: DOCUMENT_ID } : null,
    error: null,
  }));
  const is = vi.fn(() => ({ maybeSingle }));
  const ownerEq = vi.fn(() => ({ is }));
  const idEq = vi.fn(() => ({ eq: ownerEq }));
  const select = vi.fn(() => ({ eq: idEq }));
  const from = vi.fn(() => ({ select }));

  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getClaims: vi.fn(async () => ({
        data: userId ? { claims: { sub: userId } } : null,
        error: userId ? null : { message: "signed out" },
      })),
    },
    from,
    storage: {
      from: vi.fn(() => ({ createSignedUrl })),
    },
  } as never);

  return { createSignedUrl, from, idEq, is, ownerEq, select };
}

function requestMedia(ownerId = OWNER_ID) {
  return GET(new Request("https://mushpot.app/media"), {
    params: Promise.resolve({
      bucket: "document-images",
      path: [ownerId, DOCUMENT_ID, "photo.png"],
    }),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("private document media route", () => {
  it("signs media only when its completed source document still exists", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    const { createSignedUrl, from, idEq, is, ownerEq, select } =
      createSupabaseMock();

    const response = await requestMedia();

    expect(from).toHaveBeenCalledWith("documents");
    expect(select).toHaveBeenCalledWith("id");
    expect(idEq).toHaveBeenCalledWith("id", DOCUMENT_ID);
    expect(ownerEq).toHaveBeenCalledWith("owner", OWNER_ID);
    expect(is).toHaveBeenCalledWith("clone_status", null);
    expect(createSignedUrl).toHaveBeenCalledWith(
      `${OWNER_ID}/${DOCUMENT_ID}/photo.png`,
      5 * 60,
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain(
      "https://project-ref.supabase.co/storage/v1/object/sign/",
    );
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
  });

  it("does not sign orphaned media after its document is deleted", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    const { createSignedUrl } = createSupabaseMock({
      sourceDocumentExists: false,
    });

    const response = await requestMedia();

    expect(response.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("requires an authenticated owner", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    const { createSignedUrl } = createSupabaseMock({ userId: null });

    const response = await requestMedia();

    expect(response.status).toBe(401);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("rejects media paths belonging to another owner", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    const { createSignedUrl } = createSupabaseMock();

    const response = await requestMedia(
      "33333333-3333-4333-8333-333333333333",
    );

    expect(response.status).toBe(403);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses a signed URL from an unexpected origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    createSupabaseMock({
      signedUrl: "https://attacker.example/document-images/photo.png",
    });

    const response = await requestMedia();

    expect(response.status).toBe(500);
  });
});
