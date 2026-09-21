// @vitest-environment jsdom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { markdownLiveFormatting } from "@/components/editor/editor-appearance";

let view: EditorView | undefined;

function createView(doc: string) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdown({ base: markdownLanguage }), markdownLiveFormatting],
    }),
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
});

const referenceCases = [
  { name: "full reference label", source: "[Label][two\nlines]", definition: "two lines" },
  { name: "full link label", source: "[two\nlines][target]", definition: "target" },
  { name: "collapsed reference", source: "[two\nlines][]", definition: "two lines" },
  { name: "shortcut reference", source: "[two\nlines]", definition: "two lines" },
];

describe("multiline Markdown previews", () => {
  it.each(referenceCases)("opens and edits a $name link", ({ source, definition }) => {
    const doc = `Intro\n\n${source}\n\n[${definition}]: https://example.com`;
    const editor = createView(doc);
    expect(editor.dom.querySelector<HTMLElement>("[data-href]")?.dataset.href).toBe("https://example.com");

    editor.dispatch({ changes: { from: 0, insert: "Edited " } });

    expect(editor.state.doc.toString()).toBe(`Edited ${doc}`);
    expect(editor.dom.querySelector<HTMLElement>("[data-href]")?.dataset.href).toBe("https://example.com");
  });

  it.each(referenceCases)("keeps a $name image editable as source", ({ source, definition }) => {
    const imageSource = `!${source}{width=50%}`;
    const doc = `Intro\n\n${imageSource}\n\n[${definition}]: https://example.com/a.png`;
    const editor = createView(doc);
    expect(editor.dom.querySelector("img[src]")).toBeNull();
    expect(Array.from(editor.dom.querySelectorAll(".cm-line"), (line) => line.textContent).join("\n")).toContain(imageSource);

    editor.dispatch({ changes: { from: 0, insert: "Edited " } });

    expect(editor.state.doc.toString()).toBe(`Edited ${doc}`);
    expect(editor.dom.querySelector("img[src]")).toBeNull();
  });

  it.each([
    { name: "link", prefix: "" },
    { name: "image", prefix: "!" },
  ])("handles a $name reference becoming multiline and single-line again", ({ prefix }) => {
    const doc = `Intro\n\n${prefix}[Label][two lines]\n\n[two lines]: https://example.com/a.png`;
    const editor = createView(doc);
    const selector = prefix ? "img[src]" : "[data-href]";
    expect(editor.dom.querySelector(selector)).not.toBeNull();
    const splitAt = doc.indexOf("two lines") + 3;

    editor.dispatch({ changes: { from: splitAt, to: splitAt + 1, insert: "\n" } });

    expect(editor.state.doc.toString()).toBe(doc.slice(0, splitAt) + "\n" + doc.slice(splitAt + 1));
    if (prefix) expect(editor.dom.querySelector("img[src]")).toBeNull();
    else expect(editor.dom.querySelector(selector)).not.toBeNull();

    editor.dispatch({ changes: { from: splitAt, to: splitAt + 1, insert: " " } });

    expect(editor.state.doc.toString()).toBe(doc);
    expect(editor.dom.querySelector(selector)).not.toBeNull();
  });

  it("preserves line breaks around inline destinations and titles", () => {
    const doc = "Intro\n\n[Label](\nhttps://example.com\n\"Link title\"\n)\n\n![Photo](https://example.com/a.png\n\"Image title\")";
    const editor = createView(doc);
    expect(editor.dom.querySelector<HTMLElement>("[data-href]")?.dataset.href).toBe("https://example.com");
    expect(editor.dom.querySelector("img[src]")).toBeNull();
    expect(editor.state.doc.toString()).toBe(doc);
  });
});
