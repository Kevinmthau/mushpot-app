// @vitest-environment jsdom

import { createElement } from "react";
import * as ReactDOMClient from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  renderDocumentHtmlBody,
  renderDocumentHtmlBodyByFormat,
} from "@/components/editor/document-html-renderer";
import { SharedDocumentPageClient } from "@/components/editor/shared-document-page-client";
import { markdownLinkFixtures, markdownMediaFixtures } from "@/lib/markdown/rendering-fixtures";
import {
  PAGE_JSON_CONTENT_FORMAT,
  serializePageDocument,
} from "@/lib/page-document";

vi.mock("react-dom/client", { spy: true });

const cleanups: Array<() => void> = [];

function render(content: string, title = "Document") {
  const result = renderDocumentHtmlBody({ title, content });
  cleanups.push(result.dispose);
  return result.container;
}

function renderShared(content: string) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(createElement(SharedDocumentPageClient, {
    content, documentId: "document", shareToken: "token", title: "Document",
    updatedAt: "2026-09-17T12:00:00.000Z",
  }));
  return container.querySelector("article")!;
}

afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

describe("HTML export Markdown", () => {
  it.each(markdownMediaFixtures)("preserves $name media and width", (fixture) => {
    const source = `Intro\n\n${fixture.markdown}\n\nAfter`;
    const exported = render(source);
    const shared = renderShared(source);
    const video = "video" in fixture && fixture.video;
    const media = exported.querySelector<HTMLImageElement | HTMLVideoElement>(video ? "video" : "img");
    const sharedMedia = shared.querySelector<HTMLImageElement | HTMLVideoElement>(video ? "video" : "img");

    expect(media).not.toBeNull();
    expect(media!.dataset.exportSrc).toBe(sharedMedia!.getAttribute("src"));
    expect(media!.style.width).toBe(fixture.width);
    expect(media!.hasAttribute("src")).toBe(false);
    expect(media!.hasAttribute("poster")).toBe(false);
    expect(exported.textContent).not.toContain("{width=");
    expect(exported.textContent).not.toContain("{ width =");
    if ("poster" in fixture) expect(media!.dataset.exportPoster).toBe(fixture.poster);
    if (!video) expect((media as HTMLImageElement).alt).toBe("alt" in fixture ? fixture.alt : "Photo");
  });

  it.each(markdownLinkFixtures)("matches shared link destinations: %s", (source) => {
    const exportedLink = render(source).querySelector("article a");
    const sharedLink = renderShared(source).querySelector("a");
    expect(exportedLink!.getAttribute("href")).toBe(sharedLink!.getAttribute("href"));
    expect(exportedLink!.textContent).toBe(sharedLink!.textContent);
    expect(exportedLink!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders GFM tables, task lists, strikethrough, footnotes, and ordinary prose", () => {
    const exported = render([
      "# Heading", "", "**Strong** and *emphasis* with `code` and ~~gone~~.", "",
      "> Quoted", "", "- [x] Done", "- [ ] Later", "",
      "| Left | Right |", "| :--- | ---: |", "| A | B |", "",
      "```js", "const value = '<script>';", "```", "",
      "Footnote[^1]", "", "[^1]: A note", "", "---",
    ].join("\n"));

    expect(exported.querySelector("article h1")!.textContent).toBe("Heading");
    expect(exported.querySelector("strong")!.textContent).toBe("Strong");
    expect(exported.querySelector("em")!.textContent).toBe("emphasis");
    expect(exported.querySelector("del")!.textContent).toBe("gone");
    expect(exported.querySelector("blockquote")!.textContent).toContain("Quoted");
    const tasks = exported.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(Array.from(tasks, (task) => [task.checked, task.disabled])).toEqual([[true, true], [false, true]]);
    expect(exported.querySelector('.markdown-table-preview[role="region"] table')).not.toBeNull();
    expect(exported.querySelector("th")!.style.textAlign).toBe("left");
    expect(exported.querySelector("pre code")!.textContent).toBe("const value = '<script>';\n");
    expect(exported.querySelector('[data-footnotes]')!.textContent).toContain("A note");
    expect(exported.querySelector("hr")).not.toBeNull();
  });

  it("uses a literal escaped title and an Untitled fallback", () => {
    const title = '<script>alert("title")</script> & Notes\nNext line';
    const exported = render("Body", title);
    expect(exported.querySelector("main > h1")!.textContent).toBe(title);
    expect(exported.querySelector("script")).toBeNull();
    expect(exported.innerHTML).toContain("&lt;script&gt;");
    expect(render("", "").querySelector("h1")!.textContent).toBe("Untitled");
  });

  it("preserves literal HTML and unresolved Markdown references as text", () => {
    const source = '<script>alert("body")</script>\n\n<img src="https://example.com/a.png" onerror="alert(1)">\n\n![Photo][missing]{width=50%} and [Label][missing]';
    const exported = render(source);
    expect(exported.querySelector("script, img, [onerror]")).toBeNull();
    expect(exported.textContent).toContain('<script>alert("body")</script>');
    expect(exported.textContent).toContain("![Photo][missing]{width=50%}");
    expect(exported.textContent).toContain("[Label][missing]");
  });

  it.each(["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "blob:https://example.com/id"])(
    "rejects unsafe media and link destinations: %s",
    (url) => {
      const exported = render(`![Photo](<${url}>)\n\n[Link](<${url}>)`);
      expect(exported.querySelector("img, video, [data-export-src]")).toBeNull();
      expect(exported.querySelector("article a")!.hasAttribute("href")).toBe(false);
    },
  );

  it.each(["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "blob:https://example.com/id"])(
    "rejects unsafe video poster metadata: %s",
    (poster) => {
      const exported = render(`![Clip](https://example.com/movie.mp4 "poster=${poster}")`);
      const video = exported.querySelector("video")!;
      expect(video.dataset.exportPoster).toBeUndefined();
      expect(video.dataset.exportSrc).toBe("https://example.com/movie.mp4#t=0.1");
    },
  );

  it("preserves local media routes, existing video fragments, and safe posters without loading them", () => {
    const exported = render('![Clip](/m/document-videos/owner/doc/movie.mov#t=3)\n\n![Preview](/m/document-videos/owner/doc/movie.mp4 "poster=/m/document-images/owner/doc/poster.jpg")');
    const [clip, preview] = exported.querySelectorAll("video");
    expect(clip.dataset.exportSrc).toBe("/m/document-videos/owner/doc/movie.mov#t=3");
    expect(preview.dataset.exportSrc).toBe("/m/document-videos/owner/doc/movie.mp4");
    expect(preview.dataset.exportPoster).toBe("/m/document-images/owner/doc/poster.jpg");
    expect(exported.querySelector("[src], [poster], link, script")).toBeNull();
    expect(clip.controls).toBe(true);
    expect(clip.playsInline).toBe(true);
    expect(clip.preload).toBe("none");
  });

  it("keeps standalone URLs as plain links and starts no preview requests", () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const exported = render("https://example.com/story");
    expect(exported.querySelector("article > p > a")!.textContent).toBe("https://example.com/story");
    expect(exported.querySelector(".link-preview, nav, button")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps code examples and invalid image width metadata literal", () => {
    const source = '![Photo](https://example.com/a.png){width=101%}\n\n`![Example](https://example.com/b.png){width=50%}`';
    const exported = render(source);
    expect(exported.querySelectorAll("img")).toHaveLength(1);
    expect(exported.querySelector("img")!.style.width).toBe("");
    expect(exported.textContent).toContain("{width=101%}");
    expect(exported.querySelector("code")!.textContent).toContain("{width=50%}");
  });

  it("returns detached markup and disposes it idempotently", () => {
    const result = renderDocumentHtmlBody({ title: "Document", content: "Body" });
    expect(result.container.isConnected).toBe(false);
    expect(result.container.querySelector("main article")!.textContent).toBe("Body");
    result.dispose();
    result.dispose();
    expect(result.container.childNodes).toHaveLength(0);
  });

  it("unmounts the temporary root when rendering fails", () => {
    const createRoot = ReactDOMClient.createRoot;
    let unmount: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(ReactDOMClient, "createRoot").mockImplementationOnce((container, options) => {
      const root = createRoot(container, options);
      unmount = vi.spyOn(root, "unmount");
      return root;
    });
    expect(() => renderDocumentHtmlBody({ title: "Document", content: 42 as unknown as string })).toThrow();
    expect(unmount).toHaveBeenCalledOnce();
  });
});

describe("HTML export structured pages", () => {
  it("renders the versioned page schema and keeps media inert for embedding", () => {
    const content = serializePageDocument({
      schema: "mushpot.page",
      version: 1,
      theme: "editorial",
      width: "wide",
      content: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "A real web page" }],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Rich ", marks: [{ type: "bold" }] },
              {
                type: "text",
                text: "content",
                marks: [{ type: "link", attrs: { href: "https://example.com" } }],
              },
            ],
          },
          {
            type: "image",
            attrs: { src: "https://example.com/photo.webp", alt: "Photo" },
          },
          {
            type: "video",
            attrs: {
              src: "https://example.com/clip.mp4",
              poster: "https://example.com/poster.webp",
              alt: "Clip",
            },
          },
        ],
      },
    });
    const result = renderDocumentHtmlBodyByFormat({
      title: "Page title",
      content,
      contentFormat: PAGE_JSON_CONTENT_FORMAT,
    });
    cleanups.push(result.dispose);

    const main = result.container.querySelector("main")!;
    expect(main.dataset.pageTheme).toBe("editorial");
    expect(main.dataset.pageWidth).toBe("wide");
    expect(main.querySelector("article.page-body h1")?.textContent).toBe(
      "A real web page",
    );
    expect(main.querySelector("strong")?.textContent).toBe("Rich ");
    expect(main.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com",
    );
    const image = main.querySelector("img")!;
    expect(image.dataset.exportSrc).toBe("https://example.com/photo.webp");
    expect(image.hasAttribute("src")).toBe(false);
    const video = main.querySelector("video")!;
    expect(video.dataset.exportSrc).toBe("https://example.com/clip.mp4");
    expect(video.dataset.exportPoster).toBe("https://example.com/poster.webp");
    expect(video.hasAttribute("src")).toBe(false);
    expect(video.hasAttribute("poster")).toBe(false);
  });

  it("uses the same controlled page markup for public shares", () => {
    const content = serializePageDocument({
      schema: "mushpot.page",
      version: 1,
      theme: "paper",
      width: "prose",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Shared page prose" }],
          },
        ],
      },
    });
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(SharedDocumentPageClient, {
        content,
        contentFormat: PAGE_JSON_CONTENT_FORMAT,
        documentId: "document",
        shareToken: "token",
        title: "Document",
        updatedAt: "2026-09-17T12:00:00.000Z",
      }),
    );

    expect(container.querySelector("article.page-body")?.textContent).toBe(
      "Shared page prose",
    );
    expect(container.querySelector("main")?.dataset.pageTheme).toBe("paper");
    expect(container.textContent).not.toContain("mushpot.page");
  });
});
