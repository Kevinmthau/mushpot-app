// @vitest-environment jsdom

import { Facet, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeMirrorEditor } from "@/components/editor/code-mirror-editor";

const baseExtensions: Extension[] = [];
const dynamicFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? false,
});

let host: HTMLDivElement;
let root: Root;

function Probe({ enabled }: { enabled: boolean }) {
  return createElement(CodeMirrorEditor, {
    documentId: "document",
    dynamicExtension: enabled ? dynamicFacet.of(true) : undefined,
    extensions: baseExtensions,
    initialValue: "Body",
  });
}

function editor() {
  return EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("CodeMirror dynamic extensions", () => {
  it("reconfigures the existing editor without replacing its document", async () => {
    await act(async () => root.render(createElement(Probe, { enabled: false })));
    const original = editor();
    original.dispatch({ changes: { from: original.state.doc.length, insert: "!" } });

    await act(async () => root.render(createElement(Probe, { enabled: true })));

    expect(editor()).toBe(original);
    expect(editor().state.doc.toString()).toBe("Body!");
    expect(editor().state.facet(dynamicFacet)).toBe(true);
  });
});
