// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exportDocumentHtml } from "@/components/editor/document-html-export";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: vi.fn(),
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const DOCUMENT = "22222222-2222-4222-8222-222222222222";
const IMAGE_PATH = `${OWNER}/${DOCUMENT}/photo.png`;
const VIDEO_PATH = `${OWNER}/${DOCUMENT}/clip.mp4`;
const IMAGE = `/m/document-images/${IMAGE_PATH}`;
const VIDEO = `/m/document-videos/${VIDEO_PATH}`;

function createStorageMock() {
  const download = vi.fn<(path: string, options?: unknown, parameters?: {
    signal?: AbortSignal;
    cache?: RequestCache;
  }) => Promise<{ data: Blob | null; error: { message: string } | null }>>(async () => ({
    data: new Blob(["image bytes"], { type: "image/png" }),
    error: null as { message: string } | null,
  }));
  const from = vi.fn<(bucket: string) => { download: typeof download }>(() => ({ download }));
  vi.mocked(getSupabaseBrowserClient).mockResolvedValue({
    storage: { from },
  } as unknown as SupabaseBrowserClient);
  return { download, from };
}

function parseHtml(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("document HTML export", () => {
  it("creates a standalone document with escaped title, inline styling, and no backend access for text", async () => {
    const title = '</title><script>alert("secret")</script>';
    const { html, filename } = await exportDocumentHtml({
      title,
      content: "# Heading\n\n**Draft**\n\n<script>alert('body')</script>",
      owner: OWNER,
    });
    const page = parseHtml(html);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(page.title).toBe(title);
    expect(page.querySelector("main > h1")?.textContent).toBe(title);
    expect(page.querySelector('meta[charset="utf-8"]')).not.toBeNull();
    expect(page.querySelector('meta[name="viewport"]')).not.toBeNull();
    expect(page.querySelector("style")?.textContent).toContain(".markdown-body");
    expect(page.querySelector("strong")?.textContent).toBe("Draft");
    expect(page.querySelector("script, button, link")).toBeNull();
    expect(page.querySelector("article")?.textContent).toContain("<script>");
    expect(filename).not.toMatch(/[/\\:*?"<>|\u0000-\u001f]/);
    expect(filename.endsWith(".html")).toBe(true);
    expect(getSupabaseBrowserClient).not.toHaveBeenCalled();
  });

  it.each([
    ["  ", "Untitled.html"],
    ["Week/notes: draft?", "Week_notes_ draft_.html"],
    ["Résumé", "Résumé.html"],
    ["...", "Untitled.html"],
  ])("names the file for %j", async (title, filename) => {
    expect((await exportDocumentHtml({ title, content: "", owner: OWNER })).filename)
      .toBe(filename);
  });

  it("embeds owned images and deduplicates stable and legacy references to the same object", async () => {
    const { download, from } = createStorageMock();
    const legacy = `https://project.supabase.co/storage/v1/object/public/document-images/${IMAGE_PATH}`;
    const absolute = new URL(IMAGE, window.location.href).href;
    const { html } = await exportDocumentHtml({
      title: "Images",
      content: `![First](${IMAGE}){width=50%}\n\n![Again](${legacy})\n\n![Absolute](${absolute})`,
      owner: OWNER,
    });
    const page = parseHtml(html);
    const images = Array.from(page.querySelectorAll("img"));
    expect(images).toHaveLength(3);
    expect(images[0].style.width).toBe("50%");
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "data:image/png;base64,aW1hZ2UgYnl0ZXM=",
      "data:image/png;base64,aW1hZ2UgYnl0ZXM=",
      "data:image/png;base64,aW1hZ2UgYnl0ZXM=",
    ]);
    expect(from).toHaveBeenCalledWith("document-images");
    expect(download).toHaveBeenCalledExactlyOnceWith(IMAGE_PATH, undefined, {
      signal: undefined,
      cache: "no-store",
    });
    expect(html).not.toContain("data-export-");
    expect(html).not.toContain("/m/");
    expect(html).not.toContain("supabase.co");
  });

  it("embeds videos and posters sequentially, preserving widths and first-frame fragments", async () => {
    const { download, from } = createStorageMock();
    download.mockResolvedValueOnce({ data: new Blob(["video"], { type: "video/mp4" }), error: null });
    const { html } = await exportDocumentHtml({
      title: "Video",
      content: `![Clip](${VIDEO} "poster=${IMAGE}"){width=240}\n\n![First frame](${VIDEO})`,
      owner: OWNER,
    });
    const videos = parseHtml(html).querySelectorAll("video");
    expect(videos[0].getAttribute("src")).toBe("data:video/mp4;base64,dmlkZW8=");
    expect(videos[0].getAttribute("poster")).toBe("data:image/png;base64,aW1hZ2UgYnl0ZXM=");
    expect(videos[0].style.width).toBe("240px");
    expect(videos[0].hasAttribute("controls")).toBe(true);
    expect(videos[1].getAttribute("src")).toBe("data:video/mp4;base64,dmlkZW8=#t=0.1");
    expect(download.mock.calls.map(([path]) => path)).toEqual([VIDEO_PATH, IMAGE_PATH]);
    expect(from.mock.calls.map(([bucket]) => bucket)).toEqual(["document-videos", "document-images"]);
  });

  it("waits for one media download before starting the next", async () => {
    const { download } = createStorageMock();
    let finish!: (result: Awaited<ReturnType<typeof download>>) => void;
    download.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const exporting = exportDocumentHtml({
      title: "Sequential",
      content: `![A](${IMAGE})\n\n![B](${VIDEO})`,
      owner: OWNER,
    });
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    finish({ data: new Blob(["image"], { type: "image/png" }), error: null });
    await exporting;
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("keeps external media linked and makes relative links usable from a local file", async () => {
    const { html } = await exportDocumentHtml({
      title: "Links",
      content: "![Remote](https://example.com/photo.png)\n\n[App](/doc/another) [Local](#heading) [External](https://example.com/story)",
      owner: OWNER,
    });
    const page = parseHtml(html);
    expect(page.querySelector("img")?.getAttribute("src")).toBe("https://example.com/photo.png");
    const [app, local, external] = page.querySelectorAll("a");
    expect(app.getAttribute("href")).toBe(new URL("/doc/another", window.location.href).href);
    expect(app.getAttribute("target")).toBe("_blank");
    expect(local.getAttribute("href")).toBe("#heading");
    expect(local.hasAttribute("target")).toBe(false);
    expect(external.getAttribute("href")).toBe("https://example.com/story");
    expect(external.getAttribute("target")).toBe("_blank");
    expect(getSupabaseBrowserClient).not.toHaveBeenCalled();
  });

  it("preserves same-page footnote navigation and accessible references in the downloaded HTML", async () => {
    const { html } = await exportDocumentHtml({
      title: "Footnotes",
      content: "First[^note] and second[^note].\n\n[^note]: A note",
      owner: OWNER,
    });
    const page = parseHtml(html);
    const references = Array.from(page.querySelectorAll<HTMLAnchorElement>("a[data-footnote-ref]"));
    const backlinks = Array.from(page.querySelectorAll<HTMLAnchorElement>("a[data-footnote-backref]"));
    expect(references).toHaveLength(2);
    expect(backlinks).toHaveLength(2);
    expect(new Set(references.map((reference) => reference.id)).size).toBe(2);

    for (const reference of references) {
      expect(reference.id).not.toBe("");
      expect(reference.getAttribute("aria-describedby")).toBe("footnote-label");
      expect(page.getElementById(reference.getAttribute("aria-describedby")!)?.textContent).toBe("Footnotes");
    }
    expect(backlinks.map((backlink) => backlink.getAttribute("href")))
      .toEqual(references.map((reference) => `#${reference.id}`));
    for (const backlink of backlinks) {
      expect(backlink.getAttribute("aria-label")).toMatch(/Back to reference/);
    }
    for (const anchor of [...references, ...backlinks]) {
      const href = anchor.getAttribute("href")!;
      expect(href.startsWith("#")).toBe(true);
      expect(page.getElementById(href.slice(1))).not.toBeNull();
      expect(anchor.hasAttribute("target")).toBe(false);
    }
  });

  it("preserves broken external destinations without blocking the document's export", async () => {
    const { html } = await exportDocumentHtml({
      title: "Broken link",
      content: "Valid prose\n\n[Broken](<http://[>)\n\n![Broken image](<http://[>)",
      owner: OWNER,
    });
    const page = parseHtml(html);
    expect(page.querySelector("article")?.textContent).toContain("Valid prose");
    expect(page.querySelector("a")?.getAttribute("href")).toBe("http://%5B");
    expect(page.querySelector("img")?.getAttribute("src")).toBe("http://%5B");
    expect(getSupabaseBrowserClient).not.toHaveBeenCalled();
  });

  it("rejects another owner's media and malformed managed paths", async () => {
    const { download } = createStorageMock();
    const foreign = IMAGE.replace(OWNER, "33333333-3333-4333-8333-333333333333");
    await expect(exportDocumentHtml({ title: "Foreign", content: `![A](${foreign})`, owner: OWNER }))
      .rejects.toThrow("another account");
    await expect(exportDocumentHtml({ title: "Invalid", content: "![A](/m/document-images/invalid)", owner: OWNER }))
      .rejects.toThrow("Unable to include uploaded media");
    expect(download).not.toHaveBeenCalled();
  });

  it("fails with a retryable message when a media object is missing", async () => {
    const { download } = createStorageMock();
    download.mockResolvedValue({ data: null, error: { message: "Object missing" } });
    await expect(exportDocumentHtml({ title: "Missing", content: `![A](${IMAGE})`, owner: OWNER }))
      .rejects.toThrow("try Download HTML again");
  });

  it("infers a media MIME type for binary downloads and rejects unexpected HTML", async () => {
    const { download } = createStorageMock();
    download.mockResolvedValueOnce({ data: new Blob(["binary"], { type: "application/octet-stream" }), error: null });
    const { html } = await exportDocumentHtml({ title: "Binary", content: `![A](${IMAGE})`, owner: OWNER });
    expect(parseHtml(html).querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,YmluYXJ5");
    download.mockResolvedValueOnce({ data: new Blob(["<script>bad()</script>"], { type: "text/html" }), error: null });
    await expect(exportDocumentHtml({ title: "Bad", content: `![A](${IMAGE})`, owner: OWNER }))
      .rejects.toThrow("Unable to include uploaded media");
  });

  it("passes cancellation to storage and stops before embedding a late response", async () => {
    const { download } = createStorageMock();
    let finish!: (result: Awaited<ReturnType<typeof download>>) => void;
    download.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const exporting = exportDocumentHtml({ title: "Cancel", content: `![A](${IMAGE})`, owner: OWNER }, { signal: controller.signal });
    const rejected = expect(exporting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    controller.abort();
    finish({ data: new Blob(["late"], { type: "image/png" }), error: null });
    await rejected;
    expect(download).toHaveBeenCalledWith(IMAGE_PATH, undefined, {
      signal: controller.signal,
      cache: "no-store",
    });
  });

  it("does not start an already-cancelled export", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(exportDocumentHtml({ title: "Cancelled", content: `![A](${IMAGE})`, owner: OWNER }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(getSupabaseBrowserClient).not.toHaveBeenCalled();
  });
});
