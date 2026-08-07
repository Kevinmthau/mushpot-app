import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { markdownLiveFormatting } from "@/components/editor/editor-appearance";
import type { ParsedMarkdownTable } from "@/lib/markdown/table";

const TABLE = ["| Name | Value |", "| --- | --- |", "| One | Two |"].join(
  "\n",
);

function createState(doc: string, anchor: number) {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      markdown({ base: markdownLanguage }),
      markdownLiveFormatting,
    ],
  });
}

function blockPreviewCount(state: EditorState) {
  let count = 0;
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") {
      continue;
    }

    (source as DecorationSet).between(0, state.doc.length, (_from, _to, value) => {
      if (value.spec.block) {
        count += 1;
      }
    });
  }
  return count;
}

type MarkdownTableWidgetProbe = {
  eq: (other: MarkdownTableWidgetProbe) => boolean;
  table: ParsedMarkdownTable;
};

function blockPreviewWidgets(state: EditorState) {
  const widgets: MarkdownTableWidgetProbe[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") {
      continue;
    }

    (source as DecorationSet).between(0, state.doc.length, (_from, _to, value) => {
      if (value.spec.block && value.spec.widget) {
        widgets.push(value.spec.widget as MarkdownTableWidgetProbe);
      }
    });
  }
  return widgets;
}

describe("Markdown table previews", () => {
  it("previews a table-only document at either selection boundary", () => {
    expect(blockPreviewCount(createState(TABLE, 0))).toBe(1);
    expect(blockPreviewCount(createState(TABLE, TABLE.length))).toBe(1);
  });

  it("reveals source while the selection is inside a table", () => {
    const initialState = createState(TABLE, 0);
    const editingState = initialState.update({ selection: { anchor: 2 } }).state;
    const previewState = editingState.update({
      selection: { anchor: TABLE.length },
    }).state;

    expect(blockPreviewCount(editingState)).toBe(0);
    expect(blockPreviewCount(previewState)).toBe(1);
  });

  it("leaves nested table syntax unpreviewed when it cannot stand alone", () => {
    const blockquotedTable = TABLE.split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

    expect(blockPreviewCount(createState(blockquotedTable, 0))).toBe(0);
  });

  it("passes external reference definitions into table previews", () => {
    const source = `${TABLE.replace("One", "[One][value]")}\n\n[value]: https://example.com/one`;
    const [widget] = blockPreviewWidgets(createState(source, 0));

    expect(widget.table.rows[0][0].content).toEqual([
      {
        children: [{ text: "One", type: "text" }],
        href: "https://example.com/one",
        title: null,
        type: "link",
      },
    ]);
  });

  it("invalidates a table widget when only its reference definition changes", () => {
    const originalUrl = "https://example.com/one";
    const replacementUrl = "https://example.com/two";
    const source = `${TABLE.replace("One", "[One][value]")}\n\n[value]: ${originalUrl}`;
    const initialState = createState(source, 0);
    const [initialWidget] = blockPreviewWidgets(initialState);
    const urlFrom = source.indexOf(originalUrl);
    const updatedState = initialState.update({
      changes: {
        from: urlFrom,
        insert: replacementUrl,
        to: urlFrom + originalUrl.length,
      },
    }).state;
    const [updatedWidget] = blockPreviewWidgets(updatedState);

    expect(initialWidget.eq(updatedWidget)).toBe(false);
    expect(updatedWidget.table.rows[0][0].content).toEqual([
      {
        children: [{ text: "One", type: "text" }],
        href: replacementUrl,
        title: null,
        type: "link",
      },
    ]);
  });
});
