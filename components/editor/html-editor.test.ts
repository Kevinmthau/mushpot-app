// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  createHtmlEditLimitExtension,
  HtmlEditor,
  HTML_PREVIEW_DEBOUNCE_MS,
  isHtmlEditorTransactionAllowed,
} from "@/components/editor/html-editor";
import {
  getUtf8ByteLength,
  HTML_CONTENT_MAX_BYTES,
} from "@/lib/html-document";

function transaction(source: string, insert: string, from = source.length, to = from) {
  const state = EditorState.create({ doc: source });
  return state.update({ changes: { from, to, insert } });
}

describe("HTML editor limits", () => {
  it("accepts normal edits and rejects empty, NUL, and oversized results", () => {
    expect(isHtmlEditorTransactionAllowed(transaction("<p>x</p>", "!"))).toBe(true);
    expect(isHtmlEditorTransactionAllowed(transaction("x", "", 0, 1))).toBe(false);
    expect(isHtmlEditorTransactionAllowed(transaction("x", "\0"))).toBe(false);
    const exact = "a".repeat(HTML_CONTENT_MAX_BYTES);
    expect(isHtmlEditorTransactionAllowed(transaction(exact, "b"))).toBe(false);
  });

  it("drops rejected CodeMirror dispatches and reports them", () => {
    const rejected = vi.fn();
    const state = EditorState.create({
      doc: "x",
      extensions: [createHtmlEditLimitExtension(rejected)],
    });
    const result = state.update({ changes: { from: 0, to: 1, insert: "" } });

    expect(result.newDoc.toString()).toBe("x");
    expect(rejected).toHaveBeenCalledOnce();
  });

  it("validates changed ranges without serializing the whole next document", () => {
    const source = "😀x";
    const candidate = transaction(source, "!", 2);
    const serialize = vi.spyOn(candidate.newDoc, "toString");

    expect(
      isHtmlEditorTransactionAllowed(candidate, getUtf8ByteLength(source)),
    ).toBe(true);
    expect(serialize).not.toHaveBeenCalled();
  });

  it("does not reject an edit whose validation window crosses a valid emoji", () => {
    const source = "a😀bc";

    expect(isHtmlEditorTransactionAllowed(transaction(source, "!", 4))).toBe(
      true,
    );
  });

  it("does not mount a preview while the editor is in source mode", () => {
    const rendered = renderToStaticMarkup(createElement(HtmlEditor, {
      documentId: "doc",
      initialValue: "<!doctype html><p>Source</p>",
      onChange: vi.fn(),
      title: "Title",
    }));

    expect(rendered).not.toContain("<iframe");
  });

  it("uses a deliberately debounced preview", () => {
    expect(HTML_PREVIEW_DEBOUNCE_MS).toBeGreaterThanOrEqual(500);
  });

  it("previews server-hydrated source when no local edit has occurred", async () => {
    const reactTestEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    const renderEditor = (initialValue: string) => createElement(HtmlEditor, {
      documentId: "doc",
      initialValue,
      onChange: vi.fn(),
      title: "Title",
    });

    try {
      await act(async () => root.render(renderEditor(
        "<!doctype html><p>Cached source</p>",
      )));
      await act(async () => root.render(renderEditor(
        "<!doctype html><p>Server source</p>",
      )));
      const previewButton = Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent === "preview");
      expect(previewButton).toBeDefined();
      await act(async () => previewButton?.click());

      const source = host.querySelector("iframe")?.getAttribute("srcdoc");
      expect(source).toContain("Server source");
      expect(source).not.toContain("Cached source");
    } finally {
      await act(async () => root.unmount());
      reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
