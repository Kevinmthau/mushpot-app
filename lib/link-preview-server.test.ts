import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  cancel: vi.fn(),
  request: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolve4 = mocks.resolve4;
    resolve6 = mocks.resolve6;
    cancel = mocks.cancel;
  },
}));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));

type ResponsePlan = {
  status?: number;
  headers?: Record<string, string | undefined>;
  chunks?: Buffer[];
  hang?: boolean;
  error?: Error;
};
let responses: ResponsePlan[];
let server: typeof import("@/lib/link-preview-server");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.resolve4.mockResolvedValue(["93.184.216.34"]);
  mocks.resolve6.mockResolvedValue([]);
  responses = [];
  mocks.request.mockImplementation((
    _url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    const plan = responses.shift() ?? {};
    const req = new EventEmitter();
    const abort = () => req.emit("error", new Error("Aborted"));
    options.signal?.addEventListener("abort", abort, { once: true });
    return Object.assign(req, {
      end: () => queueMicrotask(() => {
        if (plan.hang) return;
        options.signal?.removeEventListener("abort", abort);
        if (plan.error) {
          req.emit("error", plan.error);
          return;
        }
        const stream = Object.assign(new PassThrough(), {
          statusCode: plan.status ?? 200,
          headers: { "content-type": "text/html; charset=utf-8", ...plan.headers },
        });
        callback(stream as unknown as IncomingMessage);
        for (const chunk of plan.chunks ?? [Buffer.from("<html><head><title>A page</title></head></html>")]) {
          if (!stream.destroyed) stream.write(chunk);
        }
        if (!stream.destroyed) stream.end();
      }),
    });
  });
  server = await import("@/lib/link-preview-server");
});

afterEach(() => vi.useRealTimers());

describe("link preview destination validation", () => {
  it.each([
    "http://localhost/", "http://localhost./", "http://printer/",
    "http://metadata.google.internal/", "https://example.local/",
    "file:///etc/passwd", "ftp://example.com/", "https://user:secret@example.com/",
    "https://example.com:3000/", "https://example.com/a b", "",
    "http://127.1/", "http://2130706433/", "http://0x7f000001/",
    "http://10.0.0.1/", "http://172.16.0.1/", "http://192.168.0.1/",
    "http://169.254.169.254/", "http://100.64.0.1/", "http://0.0.0.0/",
    "http://192.0.2.1/", "http://198.18.0.1/", "http://224.0.0.1/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
    "http://[fd00::1]/", "http://[fe80::1]/", "http://[64:ff9b::a00:1]/",
    "http://[2002:7f00:1::]/", "http://[2001:db8::1]/", "http://[3fff::1]/",
  ])("rejects non-public URL %s before any DNS lookup or connection", async (url) => {
    await expect(server.getLinkPreview(url)).rejects.toMatchObject({ status: 400 });
    expect(mocks.resolve4).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "accepts the public address %s", (address) => {
      expect(server.isPublicAddress(address)).toBe(true);
    },
  );

  it("rejects private DNS answers and mixed public/private answers", async () => {
    mocks.resolve4.mockResolvedValue(["93.184.216.34", "10.0.0.1"]);
    await expect(server.getLinkPreview("https://example.com/")).rejects.toMatchObject({ status: 400 });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects private IPv6 DNS answers even when IPv4 is public", async () => {
    mocks.resolve6.mockResolvedValue(["::ffff:169.254.169.254"]);
    await expect(server.getLinkPreview("https://example.com/")).rejects.toMatchObject({ status: 400 });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("pins the validated address while preserving the hostname for HTTP and TLS", async () => {
    await server.getLinkPreview("https://example.com/article#section");
    const [url, options] = mocks.request.mock.calls[0] as [URL, RequestOptions];
    expect(url.href).toBe("https://example.com/article");
    expect(options).toMatchObject({ agent: false, family: 4 });
    const callback = vi.fn();
    mocks.resolve4.mockResolvedValue(["127.0.0.1"]);
    options.lookup!("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(mocks.resolve4).toHaveBeenCalledTimes(1);
  });

  it("revalidates redirect locations before connecting", async () => {
    responses.push({ status: 302, headers: { location: "http://169.254.169.254/latest" } });
    await expect(server.getLinkPreview("https://example.com/")).rejects.toMatchObject({ status: 400 });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("resolves and validates a redirect hostname independently", async () => {
    mocks.resolve4.mockResolvedValueOnce(["93.184.216.34"]).mockResolvedValueOnce(["10.0.0.1"]);
    responses.push({ status: 302, headers: { location: "https://other.example.com/" } });
    await expect(server.getLinkPreview("https://example.com/")).rejects.toMatchObject({ status: 400 });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("follows relative redirects and returns the final page metadata", async () => {
    responses.push({ status: 301, headers: { location: "/article" } });
    await expect(server.getLinkPreview("https://example.com/")).resolves.toMatchObject({
      url: "https://example.com/article", title: "A page",
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("stops redirect loops after three redirects", async () => {
    responses = Array.from({ length: 5 }, () => ({ status: 302, headers: { location: "/loop" } }));
    await expect(server.getLinkPreview("https://example.com/")).rejects.toMatchObject({ status: 502 });
    expect(mocks.request).toHaveBeenCalledTimes(4);
  });
});

describe("link preview metadata", () => {
  const url = new URL("https://example.com/posts/article");

  it("parses entities, quoted attributes, Open Graph metadata, and relative images", () => {
    const result = server.extractLinkPreviewMetadata(`
      <html><head><title>Fallback title</title>
      <meta content='Writing &amp; "ideas"' property="og:title">
      <meta property="og:description" content=" A good &lt;idea&gt; ">
      <meta property="og:site_name" content="My site">
      <meta property="og:image" content="../cover.jpg?a=1&amp;b=2">
      </head><body><meta property="og:title" content="Ignore body"></body></html>`, url);
    expect(result).toEqual({
      url: url.href, title: 'Writing & "ideas"', description: "A good <idea>",
      siteName: "My site", image: "https://example.com/cover.jpg?a=1&b=2",
    });
  });

  it("falls back from Twitter metadata to standard title and description", () => {
    expect(server.extractLinkPreviewMetadata(`<head><title>Standard &amp; title</title>
      <meta name="description" content="Standard description"></head>`, url)).toMatchObject({
      title: "Standard & title", description: "Standard description",
    });
    expect(server.extractLinkPreviewMetadata(`<head><title>Standard title</title>
      <meta name="twitter:title" content="Twitter title">
      <meta name="twitter:description" content="Twitter description"></head>`, url)).toMatchObject({
      title: "Twitter title", description: "Twitter description",
    });
  });

  it("does not read pretend metadata in scripts, comments, or inert content", () => {
    expect(server.extractLinkPreviewMetadata(`<head>
      <script>const fake = '<meta property="og:title" content="Script title">'</script>
      <!-- <meta property="og:title" content="Comment title"> -->
      </head><body>
      <script>const fake = '</head><meta property="og:title" content="Body script title">'</script>
      <template><title>Template title</title><meta property="og:title" content="Template metadata"></template>
      <noscript><title>Noscript title</title><meta property="og:title" content="Noscript metadata"></noscript>
      <p>&lt;meta property="og:title" content="Escaped title"&gt;</p>
      <!-- <meta property="og:title" content="Unclosed comment title">
      </body>`, url).title).toBe("example.com");
  });

  it("reads streamed HTML metadata while ignoring SVG and MathML titles", () => {
    expect(server.extractLinkPreviewMetadata(`<html><head></head><body>
      <svg><title>Diagram title</title></svg>
      <math><title>Equation title</title></math>
      <div hidden><title>Streamed page title</title>
        <meta name="description" content="First streamed description"></div>
      <meta name="description" content="Later description">
      </body></html>`, url)).toMatchObject({
      title: "Streamed page title", description: "First streamed description",
    });
  });

  it.each(["javascript:alert(1)", "data:image/png;base64,fake", "http://127.0.0.1/image.png", "http://example.com/image.png"])(
    "omits unsafe preview image %s", (image) => {
      expect(server.extractLinkPreviewMetadata(`<head><meta property="og:image" content="${image}"></head>`, url).image).toBeUndefined();
    },
  );

  it("uses a relative favicon when a page has no social image metadata", () => {
    expect(server.extractLinkPreviewMetadata(`<head><title>Workshop</title>
      <link rel="Shortcut ICON" href="../media/logo.png"></head>`, url)).toMatchObject({
      title: "Workshop", image: "https://example.com/media/logo.png",
    });
  });

  it.each(["apple-touch-icon", "apple-touch-icon-precomposed"])(
    "prefers %s to the favicon", (rel) => {
      expect(server.extractLinkPreviewMetadata(`<head>
        <link rel="icon" href="/favicon.ico">
        <link rel="${rel}" href="/touch.png"></head>`, url).image)
        .toBe("https://example.com/touch.png");
    },
  );

  it.each(["og:image", "twitter:image"])("prefers %s to page icons", (property) => {
    expect(server.extractLinkPreviewMetadata(`<head>
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="icon" href="/favicon.ico">
      <meta property="${property}" content="/cover.jpg"></head>`, url).image)
      .toBe("https://example.com/cover.jpg");
  });

  it("falls back to a safe icon when the social image cannot be used", () => {
    expect(server.extractLinkPreviewMetadata(`<head>
      <meta property="og:image" content="http://example.com/cover.jpg">
      <link rel="icon" href="/favicon.png"></head>`, url).image)
      .toBe("https://example.com/favicon.png");
  });

  it.each([
    "javascript:alert(1)", "data:image/png;base64,fake", "https://127.0.0.1/icon.png",
    "https://metadata.google.internal/icon.png", "http://example.com/icon.png",
  ])("rejects unsafe icon %s and can use a later safe icon", (image) => {
    const unsafeIcons = `<link rel="apple-touch-icon" href="${image}">
      <link rel="icon" href="${image}">`;
    expect(server.extractLinkPreviewMetadata(unsafeIcons, url).image).toBeUndefined();
    expect(server.extractLinkPreviewMetadata(`${unsafeIcons}
      <link rel="icon" href="/safe.png">`, url).image).toBe("https://example.com/safe.png");
  });

  it("does not read page icons from scripts, inert content, or unrelated link relations", () => {
    expect(server.extractLinkPreviewMetadata(`<head>
      <script>const fake = '<link rel="icon" href="/script.png">';</script>
      <link rel="preload" href="/preload.png"></head><body>
      <template><link rel="icon" href="/template.png"></template>
      <noscript><link rel="icon" href="/noscript.png"></noscript></body>`, url).image)
      .toBeUndefined();
  });

  it("bounds metadata string lengths", () => {
    const result = server.extractLinkPreviewMetadata(`<head><title>${"a".repeat(1000)}</title>
      <meta name="description" content="${"b".repeat(1000)}"></head>`, url);
    expect(result.title).toHaveLength(300);
    expect(result.description).toHaveLength(500);
  });

  it.each([
    ["deeply nested elements", "<div>".repeat(104_850)],
    ["nested formatting elements", Array.from({ length: 5_000 }, (_, index) => `<b id="${index}">`).join("")],
    ["excessive attributes on one tag", `<div ${Array.from({ length: 20_000 }, (_, index) => `a${index}="x"`).join(" ")}>`],
    ["excessive sibling elements", "<div></div>".repeat(12_000)],
    ["excessive comments", "<!-- comment -->".repeat(12_000)],
    ["foster-parented elements", `<table>${"<b></b>".repeat(12_000)}</table>`],
  ])("rejects HTML with %s within the byte limit", (_scenario, html) => {
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(512 * 1024);
    expect(() => server.extractLinkPreviewMetadata(html, url)).toThrow(server.LinkPreviewError);
  });

  it("checks the parsing deadline without waiting for an event-loop timer", () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(251);
    try {
      expect(() => server.extractLinkPreviewMetadata("<title>A page</title>".repeat(200), url))
        .toThrow(server.LinkPreviewError);
      expect(now).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("preserves metadata when tags, attributes, entities, and raw text cross parser chunks", () => {
    const html = `${" ".repeat(1_020)}<html><head>
      <script>${"x".repeat(2_040)}; const fake = '<meta property="og:title" content="Fake">';</script>
      <title>${" ".repeat(2_040)}Title &amp; text</title>
      <meta property="og:description" content="${" ".repeat(2_040)}Description &amp; text">
      </head></html>`;
    expect(server.extractLinkPreviewMetadata(html, url)).toMatchObject({
      title: "Title & text", description: "Description & text",
    });
  });

  it.each(["script", "style", "p"])(
    "preserves metadata around a large %s text node with many whitespace runs", (tag) => {
      const html = `<html><head><title>Workshop</title>
        <meta name="description" content="A workshop about learning">
        <link rel="icon" href="/media/logo.png"></head><body>
        <${tag}>${"a b c d;\n".repeat(40_000)}</${tag}>
        <meta property="og:site_name" content="Workshop site"></body></html>`;
      expect(Buffer.byteLength(html)).toBeLessThan(512 * 1024);
      expect(server.extractLinkPreviewMetadata(html, url)).toMatchObject({
        title: "Workshop", description: "A workshop about learning",
        siteName: "Workshop site", image: "https://example.com/media/logo.png",
      });
    },
  );
});

describe("link preview resource limits and caching", () => {
  it("deduplicates concurrent requests and caches successful metadata across fragments", async () => {
    await Promise.all([
      server.getLinkPreview("https://example.com/#one"),
      server.getLinkPreview("https://example.com/#two"),
    ]);
    await server.getLinkPreview("https://example.com/");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("caches failures briefly and retries after the failure cache expires", async () => {
    vi.useFakeTimers();
    responses.push({ status: 404 });
    await expect(server.getLinkPreview("https://example.com/")).rejects.toMatchObject({ status: 502 });
    await expect(server.getLinkPreview("https://example.com/")).rejects.toMatchObject({ status: 502 });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    await expect(server.getLinkPreview("https://example.com/")).resolves.toMatchObject({ title: "A page" });
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { headers: { "content-type": "image/png" } },
    { headers: { "content-encoding": "gzip" } },
    { status: 500 },
    { error: new Error("ECONNRESET") },
  ])("fails safely for unavailable responses %j", async (plan) => {
    responses.push(plan);
    await expect(server.getLinkPreview("https://example.com/")).rejects.toMatchObject({ status: 502 });
  });

  it("reads metadata streamed in later body chunks after the initial head", async () => {
    responses.push({ chunks: [
      Buffer.from('<html><head><meta charset="utf-8"></head><body><main>Page</main>'),
      Buffer.from('<script>self.__next_f.push([1,\'<meta property="og:title" content="Script data">\'])</script>'),
      Buffer.from('<div hidden><ti'),
      Buffer.from('tle>Streamed title</title><meta property="og:title" content="Streamed OG title">'),
      Buffer.from('<meta property="og:description" content="Streamed description">'),
      Buffer.from('<meta property="og:image" content="/cover.jpg"></div></body></html>'),
    ] });
    await expect(server.getLinkPreview("https://example.com/")).resolves.toMatchObject({
      title: "Streamed OG title", description: "Streamed description",
      image: "https://example.com/cover.jpg",
    });
  });

  it("does not treat a head-closing tag inside scripts or comments as the end of metadata", async () => {
    responses.push({ chunks: [
      Buffer.from('<html><head><script>const markup = "</head>";</script>'),
      Buffer.from('<!-- </head> --><meta property="og:title" content="Real title"></head></html>'),
    ] });
    await expect(server.getLinkPreview("https://example.com/")).resolves.toMatchObject({ title: "Real title" });
  });

  it("keeps head metadata when the body exceeds the byte limit", async () => {
    responses.push({ chunks: [
      Buffer.from("<html><head><title>Small head</title></he"),
      Buffer.from("ad><body>"),
      Buffer.alloc(1024 * 1024, "a"),
      Buffer.from('<meta property="og:title" content="Beyond the limit"></body></html>'),
    ] });
    await expect(server.getLinkPreview("https://example.com/")).resolves.toMatchObject({ title: "Small head" });
  });

  it("limits a large response chunk to the allowed prefix", async () => {
    responses.push({ chunks: [Buffer.concat([
      Buffer.from("<html><head><title>Small head</title></head><body>"),
      Buffer.alloc(512 * 1024, "a"),
      Buffer.from('<meta property="og:title" content="Beyond the limit"></body></html>'),
    ])] });
    await expect(server.getLinkPreview("https://example.com/")).resolves.toMatchObject({ title: "Small head" });
  });

  it("aborts slow connections within the overall deadline", async () => {
    vi.useFakeTimers();
    responses.push({ hang: true });
    const result = expect(server.getLinkPreview("https://example.com/")).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(6_000);
    await result;
    expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("limits simultaneous requests without opening more connections", async () => {
    vi.useFakeTimers();
    responses = Array.from({ length: 8 }, () => ({ hang: true }));
    const pending = Array.from({ length: 8 }, (_, index) =>
      server.getLinkPreview(`https://example.com/${index}`).catch((error) => error));
    await expect(server.getLinkPreview("https://example.com/ninth")).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.all(pending);
    expect(mocks.request).toHaveBeenCalledTimes(8);
  });

  it("limits sustained uncached requests while serving cached entries", async () => {
    for (let index = 0; index < 60; index++) {
      await server.getLinkPreview(`https://example.com/${index}`);
    }
    await expect(server.getLinkPreview("https://example.com/sixty-first")).rejects.toMatchObject({ status: 429 });
    await expect(server.getLinkPreview("https://example.com/0")).resolves.toMatchObject({ title: "A page" });
    expect(mocks.request).toHaveBeenCalledTimes(60);
  });
});
