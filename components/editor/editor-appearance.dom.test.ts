// @vitest-environment jsdom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { markdownLiveFormatting } from "@/components/editor/editor-appearance";
import { markdownRichTextPaste } from "@/components/editor/markdown-rich-text-paste";

const TABLE = "| Name | Value |\n| --- | --- |\n| One | ![Clip](/movie.mp4) |";
const SOURCE = `Intro\n\n${TABLE}\n\nAfter`;
let view: EditorView | undefined;

function createView() {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: SOURCE,
      selection: { anchor: 2 },
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

describe("table preview DOM reuse", () => {
  it("previews a repaired flattened table after paste", () => {
    const source = [
      ...[
        "Customer",
        "Who pays for compute?",
        "Experience",
        "Consumer",
        "Existing subscription provider",
        "Fusion included in another service",
      ].flatMap((cell) => ["|  |\n| - |", cell]),
      "After",
    ].join("\n\n");
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownLiveFormatting,
          markdownRichTextPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => type === "text/plain" ? source : "",
      },
    });

    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe(
      "| Customer | Who pays for compute? | Experience |\n" +
      "| --- | --- | --- |\n" +
      "| Consumer | Existing subscription provider | Fusion included in another service |\n\n" +
      "After",
    );
    expect(view.dom.querySelector(".cm-md-table-preview")).not.toBeNull();
  });

  it("previews a repaired tab-separated table after paste", () => {
    const source = [
      "1. Five ways customers could pay for Fusion",
      "Customer\tWho pays for compute?\tExperience",
      "Consumer\tExisting subscription provider\tFusion included in another service",
      "Enterprise employee\tEmployer's cloud contract\tSign in with work account",
      "Developer\tExisting AWS/Azure/GCP account\tBring your own cloud account",
      "Independent user\tFusion provider\tPay monthly or by usage",
      "Privacy-focused user\tSelf-hosted server\tNo third-party compute bill",
      "The key is that Andromeda doesn't require any particular billing relationship.",
    ].join("\n");
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownLiveFormatting,
          markdownRichTextPaste,
        ],
      }),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => type === "text/plain" ? source : "",
      },
    });

    view.contentDOM.dispatchEvent(event);

    const table = view.dom.querySelector(".cm-md-table-preview table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("th")).toHaveLength(3);
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(5);
  });

  it("retains the table and video when text shifts, and clicks reveal the current cell", () => {
    const editor = createView();
    const originalTable = editor.dom.querySelector(".cm-md-table-preview");
    const originalVideo = editor.dom.querySelector("video");
    expect(originalTable).not.toBeNull();
    expect(originalVideo).not.toBeNull();

    editor.dispatch({ changes: { from: 2, insert: "more text" } });

    expect(editor.dom.querySelector(".cm-md-table-preview")).toBe(originalTable);
    expect(editor.dom.querySelector("video")).toBe(originalVideo);
    originalTable!.querySelector("td")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0 }),
    );

    expect(editor.state.selection.main.anchor).toBe(editor.state.doc.toString().indexOf("One"));
    expect(editor.dom.querySelector(".cm-md-table-preview")).toBeNull();
  });

  it.each(["Enter", " "])("uses the shifted source position for %s", (key) => {
    const editor = createView();
    const originalTable = editor.dom.querySelector(".cm-md-table-preview");
    editor.dispatch({ changes: { from: 0, to: 3 } });
    expect(editor.dom.querySelector(".cm-md-table-preview")).toBe(originalTable);

    originalTable!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));

    expect(editor.state.selection.main.anchor).toBe(editor.state.doc.toString().indexOf("|") + 1);
    expect(editor.dom.querySelector(".cm-md-table-preview")).toBeNull();
  });
});
