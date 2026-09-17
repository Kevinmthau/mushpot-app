import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedMediaResolver } from "@/lib/shared-media-resolver";

const prefix = "/s/document/token";
const source = (name: string) =>
  `${prefix}/m/document-images/owner/document/${name}.png`;
const success = (urls: string[]) =>
  new Response(JSON.stringify({
    urls: urls.map((url) => ({
      mediaUrl: url.slice(prefix.length).split("#")[0],
      signedUrl: `https://project.supabase.co/signed/${
        url.split("/").pop()?.split("#")[0]
      }`,
    })),
    expiresIn: 300,
  }));
afterEach(() => vi.useRealTimers());

describe("shared media batching", () => {
  it("coalesces nearby media and deduplicates concurrent requests", async () => {
    vi.useFakeTimers();
    const urls = Array.from({ length: 20 }, (_, i) => source(String(i)));
    const fetcher = vi.fn(async () => success(urls));
    const resolver = createSharedMediaResolver("document", "token", fetcher);
    const results = urls.map((url) => resolver.resolve(url));
    expect(resolver.resolve(urls[0])).toBe(results[0]);
    await vi.runAllTimersAsync();
    expect(
      (await Promise.all(results)).every((result) =>
        result.url?.startsWith("https://project.supabase.co")
      ),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      `${prefix}/media`,
      expect.objectContaining({
        cache: "no-store",
        method: "POST",
        body: JSON.stringify({
          mediaUrls: urls.map((url) => url.slice(prefix.length)),
        }),
      }),
    );
  });

  it("expires cached signatures and preserves video first-frame fragments", async () => {
    vi.useFakeTimers();
    const url = `${source("video")}#t=0.001`;
    const fetcher = vi.fn(async () => success([url]));
    const resolver = createSharedMediaResolver("document", "token", fetcher);
    const first = resolver.resolve(url);
    await vi.runAllTimersAsync();
    expect((await first).url).toContain("#t=0.001");
    await resolver.resolve(url);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(286000);
    const next = resolver.resolve(url);
    await vi.runAllTimersAsync();
    await next;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("limits requests to 50 paths and does not overlap batches", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const urls = Array.from({ length: 60 }, (_, i) => source(String(i)));
    const fetcher = vi.fn().mockImplementationOnce(() =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })
    ).mockImplementationOnce(async () => success(urls.slice(50)));
    const resolver = createSharedMediaResolver("document", "token", fetcher);
    const requests = urls.map((url) => resolver.resolve(url));
    await vi.advanceTimersByTimeAsync(20);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).mediaUrls).toHaveLength(
      50,
    );
    finish(success(urls.slice(0, 50)));
    await vi.runAllTimersAsync();
    await Promise.all(requests);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back for old edge deployments but does not retry denied items", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    const resolver = createSharedMediaResolver("document", "token", fetcher);
    const first = resolver.resolve(source("first"));
    await vi.runAllTimersAsync();
    expect((await first).url).toBe(source("first"));
    const second = resolver.resolve(source("second"));
    await vi.runAllTimersAsync();
    expect((await second).url).toBe(source("second"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const denied = createSharedMediaResolver(
      "document",
      "token",
      vi.fn(async () =>
        new Response(JSON.stringify({ urls: [], expiresIn: 0 }))
      ),
    );
    const blocked = denied.resolve(source("blocked"));
    await vi.runAllTimersAsync();
    expect((await blocked).url).toBeNull();
  });

  it("leaves external and other-share media untouched", async () => {
    const fetcher = vi.fn();
    const resolver = createSharedMediaResolver("document", "token", fetcher);
    await expect(resolver.resolve("https://external.example/image.png"))
      .resolves.toMatchObject({ url: "https://external.example/image.png" });
    expect(resolver.isShared(source("first").replace("/token/", "/other/")))
      .toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("shared media retry bounds", () => {
  it("does not publish an already-expired result after a slow response", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const resolver = createSharedMediaResolver(
      "document",
      "token",
      vi.fn(() =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
      ),
    );
    const url = source("slow");
    const request = resolver.resolve(url);
    await vi.advanceTimersByTimeAsync(20);
    // A clock adjustment can invalidate a signature without consuming the
    // monotonic request timeout.
    vi.setSystemTime(Date.now() + 286000);
    finish(success([url]));
    await vi.runAllTimersAsync();
    expect(await request).toEqual({ url, expiresAt: 0 });
  });

  it.each(["fetch", "body"] as const)(
    "times out a stalled %s, aborts it, and drains later batches",
    async (phase) => {
      vi.useFakeTimers();
      const urls = Array.from({ length: 51 }, (_, index) => source(String(index)));
      let finish!: () => void;
      const fetcher = vi.fn<typeof fetch>()
        .mockImplementationOnce(async () => {
          if (phase === "fetch") {
            return new Promise<Response>((resolve) => {
              finish = () => resolve(success(urls.slice(0, 50)));
            });
          }
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              finish = () => {
                controller.enqueue(new TextEncoder().encode(
                  JSON.stringify({ urls: [], expiresIn: 300 }),
                ));
                controller.close();
              };
            },
          }));
        })
        .mockImplementationOnce(async () => success(urls.slice(50)));
      const resolver = createSharedMediaResolver("document", "token", fetcher);
      const requests = urls.map((url) => resolver.resolve(url));
      await vi.advanceTimersByTimeAsync(16);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const signal = fetcher.mock.calls[0][1]?.signal;
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(signal?.aborted).toBe(true);
      expect(await requests[0]).toEqual({ url: urls[0], expiresAt: 0 });
      await vi.advanceTimersByTimeAsync(16);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect((await requests[50]).url).toContain("/signed/50.png");
      expect(vi.getTimerCount()).toBe(0);

      // A late response must not overwrite the fallback or retain a timeout.
      finish();
      await vi.runAllTimersAsync();
      expect(await requests[0]).toEqual({ url: urls[0], expiresAt: 0 });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retries authorized signing failures while keeping denied paths unloaded", async () => {
    vi.useFakeTimers();
    const allowed = source("allowed");
    const denied = source("denied");
    const resolver = createSharedMediaResolver(
      "document",
      "token",
      vi.fn(async () =>
        new Response(JSON.stringify({
          urls: [
            {
              mediaUrl: allowed.slice(prefix.length),
              signedUrl: null,
              retry: true,
            },
            { mediaUrl: denied.slice(prefix.length), signedUrl: null },
          ],
          expiresIn: 300,
        }))
      ),
    );
    const requests = [resolver.resolve(allowed), resolver.resolve(denied)];
    await vi.runAllTimersAsync();
    expect((await requests[0]).url).toBe(allowed);
    expect((await requests[1]).url).toBeNull();
  });
});
