// @vitest-environment jsdom

import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markdownLiveFormatting } from "@/components/editor/editor-appearance";
import { markdownLinkPaste } from "@/components/editor/markdown-link-paste";
import { markdownLinkPreviews } from "@/components/editor/markdown-link-preview";
import { getLinkPreview } from "@/lib/link-preview-client";

vi.mock("@/lib/link-preview-client", () => ({
  getLinkPreview: vi.fn(async (url: string) => ({
    url,
    title: "A page worth reading",
    description: "A short summary of this page.",
  })),
}));

let view: EditorView | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // JSDOM cannot measure text ranges; keep layout outside these interaction tests.
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
});

afterEach(async () => {
  await act(async () => { view?.destroy(); });
  view = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("link previews in the live editor", () => {
  it("renders on paste, retains the card while typing elsewhere, and removes it on undo", async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "Intro\n\n",
        selection: { anchor: 7 },
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownLiveFormatting,
          markdownLinkPaste,
          markdownLinkPreviews,
          history(),
        ],
      }),
    });
    const editor = view;
    await act(async () => {
      editor.dispatch(editor.state.replaceSelection("https://example.com/page"), {
        userEvent: "input.paste",
      });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    const card = editor.dom.querySelector(".link-preview-card");
    expect(card?.textContent).toContain("A page worth reading");
    expect(card?.getAttribute("href")).toBe("https://example.com/page");
    const source = editor.state.doc.toString();
    expect(source).toBe("Intro\n\n[https://example.com/page](https://example.com/page)");

    await act(async () => {
      editor.dispatch({ changes: { from: 2, insert: "more " }, userEvent: "input.type" });
    });
    expect(editor.dom.querySelector(".link-preview-card")).toBe(card);
    await act(async () => { undo(editor); });
    expect(editor.state.doc.toString()).toBe(source);
    await act(async () => { undo(editor); });
    expect(editor.state.doc.toString()).toBe("Intro\n\n");
    expect(editor.dom.querySelector(".link-preview-card")).toBeNull();
  });

  it("requests only the completed URL after typing pauses", async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownLiveFormatting,
          markdownLinkPaste,
          markdownLinkPreviews,
        ],
      }),
    });
    const editor = view;
    const url = "https://example.com/a-long-article-slug-being-entered-by-hand";
    for (const character of url) {
      await act(async () => {
        editor.dispatch({
          changes: { from: editor.state.doc.length, insert: character },
          userEvent: "input.type",
        });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(getLinkPreview).not.toHaveBeenCalled();
    expect(editor.dom.querySelector(".link-preview-fallback")?.getAttribute("href")).toBe(url);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getLinkPreview).toHaveBeenCalledExactlyOnceWith(url);
    expect(editor.dom.querySelector(".link-preview-card")?.textContent).toContain("A page worth reading");
  });
});
