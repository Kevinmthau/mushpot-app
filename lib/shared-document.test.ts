import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSharedDocumentPreview,
  fetchSharedMediaUrl,
  normalizeSharedDocumentTitle,
} from "@/lib/shared-document";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("normalizeSharedDocumentTitle", () => {
  it("trims the title", () => {
    expect(normalizeSharedDocumentTitle("  My Doc  ")).toBe("My Doc");
  });

  it("falls back to 'Untitled' for blank titles", () => {
    expect(normalizeSharedDocumentTitle("   ")).toBe("Untitled");
  });
});

describe("buildSharedDocumentPreview", () => {
  it("returns the default description for empty content", () => {
    expect(buildSharedDocumentPreview("")).toBe(
      "Open this shared document in Mushpot.",
    );
    expect(buildSharedDocumentPreview("   \n\n  ")).toBe(
      "Open this shared document in Mushpot.",
    );
  });

  it("strips markdown syntax down to plain text", () => {
    expect(buildSharedDocumentPreview("# Heading\n\nBody text")).toBe(
      "Heading Body text",
    );
    expect(buildSharedDocumentPreview("![alt text](image.png)")).toBe(
      "alt text",
    );
    expect(buildSharedDocumentPreview("[link label](https://example.com)")).toBe(
      "link label",
    );
    expect(buildSharedDocumentPreview("> a quoted line")).toBe("a quoted line");
    expect(buildSharedDocumentPreview("- a list item")).toBe("a list item");
    expect(buildSharedDocumentPreview("`inline code`")).toBe("inline code");
    expect(buildSharedDocumentPreview("**bold** and _italic_")).toBe(
      "bold and italic",
    );
    expect(buildSharedDocumentPreview("| Col A | Col B |")).toBe("Col A Col B");
  });

  it("returns short content unchanged", () => {
    expect(buildSharedDocumentPreview("just short")).toBe("just short");
  });

  it("truncates long content at a word boundary with an ellipsis", () => {
    expect(buildSharedDocumentPreview("one two three four five", 10)).toBe(
      "one two…",
    );
  });
});

describe("fetchSharedMediaUrl", () => {
  it("requests a fresh signed URL without allowing response caching", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          signedUrl: "https://project-ref.supabase.co/storage/v1/object/sign/media",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchSharedMediaUrl("doc-id", "share-token", "/m/document-images/path"),
    ).resolves.toBe(
      "https://project-ref.supabase.co/storage/v1/object/sign/media",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://project-ref.supabase.co/functions/v1/get-shared-doc",
      expect.objectContaining({
        body: JSON.stringify({
          docId: "doc-id",
          mediaUrl: "/m/document-images/path",
          token: "share-token",
        }),
        cache: "no-store",
        method: "POST",
      }),
    );
  });

  it("rejects unsuccessful and malformed signing responses", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ signedUrl: 123 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchSharedMediaUrl("doc-id", "share-token", "/m/document-images/path"),
    ).resolves.toBeNull();
    await expect(
      fetchSharedMediaUrl("doc-id", "share-token", "/m/document-images/path"),
    ).resolves.toBeNull();
  });
});
