"use client";

import { syntaxTree } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import { decodeString } from "micromark-util-decode-string";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";
import { createRoot, type Root } from "react-dom/client";

import { LinkPreviewCard } from "@/components/editor/link-preview-card";
import { getStandaloneLinkPreviewUrl } from "@/lib/link-preview";
import {
  parseMarkdownReferenceDefinitions,
  type MarkdownReferenceDefinitions,
} from "@/lib/markdown/table";

const roots = new WeakMap<HTMLElement, Root>();
// Autolinking otherwise absorbs formatting within URL labels. Nested brackets
// are literal inside a link; retain single-tilde parsing for GFM strikethrough.
const linkLabelParser = (markdownLanguage.parser as MarkdownParser).configure({
  remove: ["Autolink", "Link", "Superscript", "Emoji"],
});

class LinkPreviewWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }

  eq(other: LinkPreviewWidget) {
    return this.url === other.url;
  }

  get estimatedHeight() {
    return 130;
  }

  toDOM(view: EditorView) {
    const element = document.createElement("div");
    element.className = "cm-link-preview";
    element.contentEditable = "false";
    const root = createRoot(element);
    roots.set(element, root);
    root.render(
      <LinkPreviewCard
        url={this.url}
        onLoad={() => {
          if (element.isConnected) view.requestMeasure();
        }}
      />,
    );
    return element;
  }

  destroy(element: HTMLElement) {
    const root = roots.get(element);
    roots.delete(element);
    // Editor teardown can run inside another React root's commit.
    queueMicrotask(() => root?.unmount());
  }

  ignoreEvent() {
    return true;
  }
}

function paragraphUrl(
  state: EditorState,
  paragraph: SyntaxNode,
  getReferences: () => MarkdownReferenceDefinitions,
) {
  const link = paragraph.firstChild;
  if (!link || link.nextSibling) return null;
  if (
    state.doc.sliceString(paragraph.from, link.from).trim() ||
    state.doc.sliceString(link.to, paragraph.to).trim()
  ) return null;

  if (link.name === "URL" || link.name === "Autolink") {
    const source = state.doc.sliceString(link.from, link.to);
    const url = link.name === "Autolink" ? source.slice(1, -1) : source;
    return getStandaloneLinkPreviewUrl(url, url);
  }
  if (link.name !== "Link") return null;

  let labelFrom: number | undefined;
  let labelTo: number | undefined;
  let destination: string | undefined;
  let referenceLabel: string | undefined;
  let hasInlineDestination = false;
  for (let child = link.firstChild; child; child = child.nextSibling) {
    const source = state.doc.sliceString(child.from, child.to);
    if (child.name === "LinkMark" && source === "[") labelFrom = child.to;
    if (child.name === "LinkMark" && source === "]") labelTo = child.from;
    if (child.name === "URL" && labelTo !== undefined) destination = source;
    if (child.name === "LinkLabel") referenceLabel = source.slice(1, -1);
    if (child.name === "LinkMark" && source === "(") hasInlineDestination = true;
  }
  if (labelFrom === undefined || labelTo === undefined) return null;
  const label = state.doc.sliceString(labelFrom, labelTo);
  if (linkLabelParser.parseInline(label, 0).some((node) =>
    !["Escape", "Entity"].includes(linkLabelParser.nodeSet.types[node.type].name)
  )) return null;

  if (hasInlineDestination) {
    if (!destination) return null;
    if (destination.startsWith("<") && destination.endsWith(">")) {
      destination = destination.slice(1, -1);
    }
    destination = decodeString(destination);
  } else {
    destination = getReferences().get(
      normalizeIdentifier(referenceLabel || label),
    )?.href;
  }
  return getStandaloneLinkPreviewUrl(
    destination,
    decodeString(label),
  );
}

function buildLinkPreviews(state: EditorState) {
  // Match the editor's live-formatting budget for long documents.
  if (state.doc.length > 20_000 || state.doc.lines > 400) return Decoration.none;
  const decorations: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  let references: MarkdownReferenceDefinitions | undefined;
  const getReferences = () => references ??= parseMarkdownReferenceDefinitions(
    state.doc.toString(), tree.topNode,
  );
  tree.iterate({
    enter(node) {
      if (node.name !== "Paragraph" || node.node.parent?.name !== "Document") return;
      const url = paragraphUrl(state, node.node, getReferences);
      if (url) {
        // Keep the source editable and show the card immediately after paste,
        // including while the cursor is still at the end of the URL.
        decorations.push(Decoration.widget({
          block: true,
          side: 1,
          widget: new LinkPreviewWidget(url),
        }).range(node.to));
      }
      return false;
    },
  });
  return Decoration.set(decorations, true);
}

export const markdownLinkPreviews = StateField.define({
  create: buildLinkPreviews,
  update(previews, transaction) {
    return transaction.docChanged ||
        syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      ? buildLinkPreviews(transaction.state)
      : previews;
  },
  provide: (field) => EditorView.decorations.from(field),
});
