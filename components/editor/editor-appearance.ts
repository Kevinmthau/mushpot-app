"use client";

import { EditorView } from "@codemirror/view";

import { markdownInlineLiveFormatting } from "@/components/editor/markdown-inline-formatting";
import { markdownTablePreviews } from "@/components/editor/markdown-table-preview";

export const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
  },
  ".cm-content": {
    caretColor: "#2f5966",
  },
  ".cm-md-strong": {
    fontWeight: "700",
  },
  ".cm-md-emphasis": {
    fontStyle: "italic",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "#d3e2e0 !important",
  },
});

export const markdownLiveFormatting = [
  markdownTablePreviews,
  markdownInlineLiveFormatting,
];
