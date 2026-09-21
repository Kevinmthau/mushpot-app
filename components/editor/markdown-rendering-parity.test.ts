// @vitest-environment jsdom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { markdownLiveFormatting } from "@/components/editor/editor-appearance";
import { SharedDocumentPageClient } from "@/components/editor/shared-document-page-client";
import { markdownLinkFixtures, markdownMediaFixtures } from "@/lib/markdown/rendering-fixtures";

let view: EditorView | undefined;

function renderEditor(content: string | Text) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: content,
      selection: { anchor: 0 },
      extensions: [markdown({ base: markdownLanguage }), markdownLiveFormatting],
    }),
  });
  return view.dom;
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
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
});

describe("editor and shared Markdown media parity", () => {
  it.each(markdownMediaFixtures)("renders $name", (fixture) => {
    const source = `Intro\n\n${fixture.markdown}\n\nAfter`;
    const editor = renderEditor(source);
    const shared = renderShared(source);
    const video = "video" in fixture && fixture.video;
    for (const root of [editor, shared]) {
      const media = root.querySelector<HTMLImageElement | HTMLVideoElement>(video ? "video" : "img[src]");
      expect(media, root === editor ? "editor media" : "shared media").not.toBeNull();
      expect(media!.src).toBe("src" in fixture ? fixture.src : "https://example.com/a.png");
      const wrapper = media!.closest<HTMLElement>(".cm-md-media-preview");
      expect(wrapper?.style.width || media!.style.width).toBe(fixture.width);
      if (wrapper?.style.width) expect(media!.style.width).toBe("100%");
      if ("poster" in fixture) expect((media as HTMLVideoElement).poster).toBe(fixture.poster);
      if (!video) expect((media as HTMLImageElement).alt).toBe("alt" in fixture ? fixture.alt : "Photo");
      expect(root.textContent).not.toContain("{width=");
      expect(root.textContent).not.toContain("{ width =");
    }
  });

  it.each([
    "{width=0}", "{width=101%}", "{width=banana}",
    String.raw`\{width=50%}`, "&#123;width=50%}", "\n{width=50%}",
  ])("keeps literal or invalid metadata: %s", (suffix) => {
    const source = `Intro\n\n![Photo](https://example.com/a.png)${suffix}\n\nAfter`;
    for (const root of [renderEditor(source), renderShared(source)]) {
      expect(root.querySelector<HTMLImageElement>("img[src]")!.style.width).toBe("");
      expect(root.textContent).toContain("width=");
    }
  });

  it("leaves code examples untouched", () => {
    const literal = "![Photo](https://example.com/a.png){width=50%}";
    const source = `Intro\n\n\`${literal}\`\n\n\`\`\`md\n${literal}\n\`\`\``;
    for (const root of [renderEditor(source), renderShared(source)]) {
      expect(root.querySelector("img[src]")).toBeNull();
      expect(root.textContent).toContain(literal);
    }
  });

  it("consumes each adjacent image's width once and preserves surrounding text", () => {
    const source = "Intro\n\n![A](https://example.com/a.png){width=30%} and ![B](https://example.com/b.png){width=70%} after";
    for (const root of [renderEditor(source), renderShared(source)]) {
      expect(Array.from(root.querySelectorAll<HTMLImageElement>("img[src]"), (image) => image.closest<HTMLElement>(".cm-md-media-preview")?.style.width || image.style.width)).toEqual(["30%", "70%"]);
      expect(root.textContent).toContain(" and ");
      expect(root.textContent).toContain(" after");
      expect(root.textContent).not.toContain("{width=");
    }
  });
});

describe("editor and shared Markdown destination parity", () => {
  it.each(markdownLinkFixtures)("resolves %s", (markdown) => {
    const source = `Intro\n\n${markdown}\n\nAfter`;
    const editor = renderEditor(source);
    const shared = renderShared(source);
    const editorLink = editor.querySelector<HTMLElement>("[data-href]");
    const sharedLink = shared.querySelector<HTMLAnchorElement>("a");
    expect(editorLink).not.toBeNull();
    expect(sharedLink).not.toBeNull();
    expect(new URL(editorLink!.dataset.href!).href).toBe(sharedLink!.href);
    expect(editorLink!.textContent).toBe(sharedLink!.textContent);
  });

  it("keeps unresolved image and link references as source", () => {
    const source = "Intro\n\n![Photo][missing]{width=50%} and [Label][missing]";
    for (const root of [renderEditor(source), renderShared(source)]) {
      expect(root.querySelector("img[src]")).toBeNull();
      expect(root.textContent).toContain("![Photo][missing]{width=50%}");
      expect(root.textContent).toContain("[Label][missing]");
    }
  });

  it("does not serialize ordinary inline destinations for reference lookup", () => {
    const doc = Text.of(["Intro", "", "![Photo](https://example.com/a.png){width=50%}", "", "[Label](https://example.com)"]);
    const serialize = vi.spyOn(doc, "toString");
    renderEditor(doc);
    expect(serialize).not.toHaveBeenCalled();
  });

  it.each(["Intro\n\n" + "x".repeat(20_001), "Intro\n\n" + "x\n".repeat(401)])("preserves the formatting budget", (prefix) => {
    const editor = renderEditor(`${prefix}\n\n![Photo](https://example.com/a.png){width=50%}`);
    expect(editor.querySelector("img[src]")).toBeNull();
  });
});
