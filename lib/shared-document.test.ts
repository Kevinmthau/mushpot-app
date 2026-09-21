import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSharedDocumentPreview,
  fetchSharedDocument,
  fetchSharedMediaUrl,
  fetchSharedMediaUrls,
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
    expect(buildSharedDocumentPreview("[link label](https://example.com)"))
      .toBe(
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
    const fetchMock = vi.fn(
      async (
        ...requestArguments: [
          input: Request | string | URL,
          init?: RequestInit,
        ]
      ) => {
        void requestArguments;
        return new Response(
          JSON.stringify({
            signedUrl:
              "https://project-ref.supabase.co/storage/v1/object/sign/media",
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchSharedMediaUrl("doc-id", "share-token", "/m/document-images/path"),
    ).resolves.toEqual({
      status: "success",
      data: "https://project-ref.supabase.co/storage/v1/object/sign/media",
    });
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
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.headers).toEqual({
      "Content-Type": "application/json",
      apikey: "anon-key",
    });
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
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      fetchSharedMediaUrl("doc-id", "share-token", "/m/document-images/path"),
    ).resolves.toEqual({ status: "unavailable" });
  });
});

describe("fetchSharedMediaUrls", () => {
  it("accepts partial results and refuses off-origin signed URLs", async () => {
    const { fetchSharedMediaUrls } = await import("@/lib/shared-document");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({
          urls: [
            {
              mediaUrl: "/m/one",
              signedUrl: "https://project.supabase.co/signed/one",
            },
            { mediaUrl: "/m/two", signedUrl: "https://unexpected.example/two" },
            { mediaUrl: "/m/three", signedUrl: null },
          ],
          expiresIn: 300,
        }))
      ),
    );
    await expect(
      fetchSharedMediaUrls("doc", "token", ["/m/one", "/m/two", "/m/three"]),
    ).resolves.toEqual({
      status: "success",
      data: { urls: [
        {
          mediaUrl: "/m/one",
          signedUrl: "https://project.supabase.co/signed/one",
        },
        { mediaUrl: "/m/two", signedUrl: null, retry: true },
        { mediaUrl: "/m/three", signedUrl: null },
      ],
      expiresIn: 300 },
    });
  });

  it("distinguishes an old edge deployment from a revoked share", async () => {
    const { fetchSharedMediaUrls } = await import("@/lib/shared-document");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ title: "Old edge", content: "Content" }),
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 404 })),
    );
    await expect(fetchSharedMediaUrls("doc", "token", ["/m/one"])).resolves
      .toEqual({ status: "unavailable" });
    await expect(fetchSharedMediaUrls("doc", "token", ["/m/one"])).resolves
      .toEqual({ status: "not_found" });
  });
});


describe("shared request failure outcomes", () => {
  it("reserves missing outcomes for invalid or revoked shares across all request types", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    for (const status of [400, 404, 401, 403, 429, 500, 503]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
      const expected = { status: status === 400 || status === 404 ? "not_found" : "unavailable" };
      expect(await fetchSharedDocument("doc", "token")).toEqual(expected);
      expect(await fetchSharedMediaUrl("doc", "token", "/m/one")).toEqual(expected);
      expect(await fetchSharedMediaUrls("doc", "token", ["/m/one"])).toEqual(expected);
    }
  });

  it("validates document responses and treats malformed JSON and network failure as unavailable", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    const document = { title: "Title", content: "Body", updated_at: "2026-09-21T00:00:00Z" };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(document));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchSharedDocument("doc", "token")).toEqual({ status: "success", data: document });
    for (const invalid of [null, {}, { ...document, content: 1 }, { ...document, updated_at: "invalid" }]) {
      fetcher.mockResolvedValueOnce(Response.json(invalid));
      expect(await fetchSharedDocument("doc", "token")).toEqual({ status: "unavailable" });
    }
    fetcher.mockResolvedValueOnce(new Response("not json"));
    expect(await fetchSharedDocument("doc", "token")).toEqual({ status: "unavailable" });
    fetcher.mockRejectedValueOnce(new Error("Network unavailable"));
    expect(await fetchSharedDocument("doc", "token")).toEqual({ status: "unavailable" });
  });

  it("never treats missing, duplicate, or malformed batch entries as access denials", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    const item = { mediaUrl: "/m/one", signedUrl: null };
    for (const urls of [[], [item, item], [{ ...item, signedUrl: 1 }], [{ ...item, retry: "yes" }]]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ urls, expiresIn: 300 })));
      expect(await fetchSharedMediaUrls("doc", "token", ["/m/one"])).toEqual({ status: "unavailable" });
    }
  });
});
