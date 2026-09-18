import { afterEach, describe, expect, it, vi } from "vitest";

import { createLinkPreviewClient } from "@/lib/link-preview-client";

const response = (title = "A page") => new Response(JSON.stringify({ title }));

afterEach(() => { vi.useRealTimers(); });

describe("link preview requests", () => {
  it("deduplicates in-flight requests and reuses successful metadata", async () => {
    const fetcher = vi.fn(async () => response());
    const getPreview = createLinkPreviewClient(fetcher);
    const first = getPreview("https://example.com");
    expect(getPreview("https://example.com/")).toBe(first);
    expect(await first).toMatchObject({ url: "https://example.com/", title: "A page" });
    expect(await getPreview("https://example.com")).toMatchObject({ title: "A page" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/link-preview?url=https%3A%2F%2Fexample.com%2F",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
  });

  it("caches network failures briefly and permits another attempt later", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response());
    const getPreview = createLinkPreviewClient(fetcher);
    expect(await getPreview("https://example.com")).toBeNull();
    expect(await getPreview("https://example.com")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    expect(await getPreview("https://example.com")).toMatchObject({ title: "A page" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("treats failed responses and malformed metadata as missing previews", async () => {
    for (const failedResponse of [
      new Response("offline", { status: 502 }),
      new Response("not json"),
      new Response(JSON.stringify({ title: "  " })),
      new Response(JSON.stringify({ url: "https://example.com" })),
    ]) {
      const getPreview = createLinkPreviewClient(vi.fn(async () => failedResponse));
      expect(await getPreview("https://example.com")).toBeNull();
    }
  });

  it("ignores unsafe images and metadata destinations", async () => {
    const getPreview = createLinkPreviewClient(vi.fn(async () => new Response(
      JSON.stringify({ url: "javascript:alert(1)", title: " A page ", image: "data:image/png,hi" }),
    )));
    expect(await getPreview("https://example.com")).toEqual({
      url: "https://example.com/", title: "A page", image: undefined,
      description: undefined, siteName: undefined,
    });
  });

  it("limits simultaneous requests and bounds queued requests", async () => {
    const completions: Array<(response: Response) => void> = [];
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => completions.push(resolve)));
    const getPreview = createLinkPreviewClient(fetcher);
    const pending = Array.from({ length: 101 }, (_, index) => getPreview(`https://example.com/${index}`));
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(await pending[100]).toBeNull();
    for (let index = 0; index < 100; index += 1) {
      completions[index](response());
      await pending[index];
      await Promise.resolve();
    }
    expect(fetcher).toHaveBeenCalledTimes(100);
  });

  it("evicts old results and never fetches unsupported URLs", async () => {
    const fetcher = vi.fn(async () => response());
    const getPreview = createLinkPreviewClient(fetcher);
    expect(await getPreview("mailto:a@example.com")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    for (let index = 0; index < 101; index += 1) {
      await getPreview(`https://example.com/${index}`);
    }
    await getPreview("https://example.com/0");
    expect(fetcher).toHaveBeenCalledTimes(102);
  });
});
