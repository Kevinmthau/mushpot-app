"use client";

import { syntaxTree } from "@codemirror/language";
import {
  EditorState,
  StateField,
  Transaction,
  type Range,
} from "@codemirror/state";
import { type SyntaxNode } from "@lezer/common";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { isSupportedVideoUrl } from "@/components/editor/image-upload-utils";
import { normalizeDocumentMediaUrl } from "@/lib/document-media";
import { parseImageWidthTokenFromText } from "@/lib/markdown/image-width";
import {
  appendFirstFrameFragment,
  parseVideoPosterFromTitle,
} from "@/lib/markdown/video-poster";
import {
  parseMarkdownReferenceDefinitions,
  parseMarkdownTable,
  type MarkdownInlineContent,
  type MarkdownTableAlignment,
  type MarkdownTableCell,
  type ParsedMarkdownTable,
} from "@/lib/markdown/table";

const DECORATION_REBUILD_INTERVAL_MS = 120;
const MAX_LIVE_FORMATTING_DOC_LENGTH = 20_000;
const MAX_LIVE_FORMATTING_LINE_COUNT = 400;

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

class HiddenMarkdownMarkWidget extends WidgetType {
  toDOM() {
    const element = document.createElement("span");
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  ignoreEvent() {
    return true;
  }
}

class MarkdownListMarkWidget extends WidgetType {
  constructor(private readonly renderedText: string) {
    super();
  }

  eq(other: MarkdownListMarkWidget) {
    return this.renderedText === other.renderedText;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-md-list-mark";
    element.setAttribute("aria-hidden", "true");
    element.textContent = this.renderedText;
    return element;
  }

  ignoreEvent() {
    return true;
  }
}

class MarkdownHorizontalRuleWidget extends WidgetType {
  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-md-horizontal-rule";
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  ignoreEvent() {
    return true;
  }
}

function createMarkdownMediaPreviewElement(
  src: string,
  altText: string,
  width: string | null,
  poster: string | null,
) {
  const isVideo = isSupportedVideoUrl(src);
  const wrapper = document.createElement("span");
  wrapper.className = isVideo
    ? "cm-md-media-preview cm-md-video-preview"
    : "cm-md-media-preview cm-md-image-preview";
  wrapper.setAttribute("aria-label", altText || (isVideo ? "Video" : "Image"));

  if (isVideo) {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    if (poster) {
      video.poster = poster;
      video.src = src;
    } else {
      video.src = appendFirstFrameFragment(src);
    }
    if (width) {
      video.style.width = width;
    }

    wrapper.appendChild(video);
    return wrapper;
  }

  const image = document.createElement("img");
  image.src = src;
  image.alt = altText;
  image.loading = "lazy";
  image.decoding = "async";
  image.draggable = false;
  if (width) {
    image.style.width = width;
  }

  wrapper.appendChild(image);
  return wrapper;
}

class MarkdownMediaPreviewWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly altText: string,
    private readonly width: string | null,
    private readonly poster: string | null,
  ) {
    super();
  }

  eq(other: MarkdownMediaPreviewWidget) {
    return (
      this.src === other.src &&
      this.altText === other.altText &&
      this.width === other.width &&
      this.poster === other.poster
    );
  }

  toDOM() {
    return createMarkdownMediaPreviewElement(
      this.src,
      this.altText,
      this.width,
      this.poster,
    );
  }
}

function appendMarkdownInlineContent(
  parent: HTMLElement,
  content: MarkdownInlineContent[],
) {
  for (const part of content) {
    if (part.type === "text") {
      parent.append(document.createTextNode(part.text));
      continue;
    }

    if (part.type === "break") {
      parent.append(document.createElement("br"));
      continue;
    }

    if (part.type === "code") {
      const code = document.createElement("code");
      code.textContent = part.text;
      parent.append(code);
      continue;
    }

    if (part.type === "media") {
      const src = normalizeDocumentMediaUrl(part.src);
      const poster = normalizeDocumentMediaUrl(
        parseVideoPosterFromTitle(part.title) ?? "",
      );
      parent.append(
        createMarkdownMediaPreviewElement(
          src,
          part.altText,
          null,
          poster || null,
        ),
      );
      continue;
    }

    const element = document.createElement(
      part.type === "strong"
        ? "strong"
        : part.type === "emphasis"
          ? "em"
          : part.type === "strikethrough"
            ? "del"
            : "span",
    );

    if (part.type === "link") {
      element.className = "cm-md-table-link";
      element.title = part.title ?? part.href;
    }

    appendMarkdownInlineContent(element, part.children);
    parent.append(element);
  }
}

function buildMarkdownTableCell(
  cell: MarkdownTableCell,
  alignment: MarkdownTableAlignment,
  isHeader: boolean,
) {
  const element = document.createElement(isHeader ? "th" : "td");
  element.dataset.tableSourcePosition = String(cell.from);
  if (alignment) {
    element.style.textAlign = alignment;
  }
  appendMarkdownInlineContent(element, cell.content);
  return element;
}

class MarkdownTableWidget extends WidgetType {
  private readonly renderKey: string;

  constructor(
    private readonly sourceFrom: number,
    private readonly table: ParsedMarkdownTable,
  ) {
    super();
    this.renderKey = JSON.stringify(table);
  }

  eq(other: MarkdownTableWidget) {
    return (
      this.sourceFrom === other.sourceFrom &&
      this.renderKey === other.renderKey
    );
  }

  private revealSource(view: EditorView, target?: EventTarget | null) {
    const targetElement = target instanceof Element ? target : null;
    const sourceCell = targetElement?.closest<HTMLElement>(
      "[data-table-source-position]",
    );
    const parsedPosition = Number.parseInt(
      sourceCell?.dataset.tableSourcePosition ?? "0",
      10,
    );
    const relativePosition = Math.max(
      1,
      Math.min(
        Number.isNaN(parsedPosition) ? 1 : parsedPosition,
        Math.max(1, this.table.source.length - 1),
      ),
    );
    const anchor = Math.min(
      this.sourceFrom + relativePosition,
      view.state.doc.length,
    );

    view.dispatch({
      annotations: Transaction.userEvent.of("select.table"),
      scrollIntoView: true,
      selection: { anchor },
    });
    view.focus();
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-preview";
    wrapper.setAttribute("aria-label", "Table preview. Press Enter to edit.");
    wrapper.setAttribute("role", "group");
    wrapper.tabIndex = 0;
    wrapper.title = "Click to edit table";

    const table = document.createElement("table");
    const tableHead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    this.table.header.forEach((cell, index) => {
      headerRow.append(
        buildMarkdownTableCell(
          cell,
          this.table.alignments[index] ?? null,
          true,
        ),
      );
    });
    tableHead.append(headerRow);
    table.append(tableHead);

    if (this.table.rows.length > 0) {
      const tableBody = document.createElement("tbody");
      this.table.rows.forEach((row) => {
        const rowElement = document.createElement("tr");
        row.forEach((cell, index) => {
          rowElement.append(
            buildMarkdownTableCell(
              cell,
              this.table.alignments[index] ?? null,
              false,
            ),
          );
        });
        tableBody.append(rowElement);
      });
      table.append(tableBody);
    }

    wrapper.append(table);
    wrapper.addEventListener("click", (event) => {
      if (event.button !== 0) {
        return;
      }

      const targetElement =
        event.target instanceof Element ? event.target : null;
      if (targetElement?.closest("video")) {
        return;
      }

      event.preventDefault();
      this.revealSource(view, event.target);
    });
    wrapper.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      this.revealSource(view, event.target);
    });

    return wrapper;
  }
}

const strongDecoration = Decoration.mark({ class: "cm-md-strong" });
const emphasisDecoration = Decoration.mark({ class: "cm-md-emphasis" });
const inlineCodeDecoration = Decoration.mark({ class: "cm-md-inline-code" });
const codeBlockTextDecoration = Decoration.mark({ class: "cm-md-code-block-text" });
const hiddenMarkdownMarkDecoration = Decoration.replace({
  widget: new HiddenMarkdownMarkWidget(),
});
const lineDecorationCache = new Map<string, Decoration>();
const linkDecorationCache = new Map<string, Decoration>();

function getCurrentTimeMs() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function shouldDisableLiveFormattingState(state: EditorState) {
  return (
    state.doc.length > MAX_LIVE_FORMATTING_DOC_LENGTH ||
    state.doc.lines > MAX_LIVE_FORMATTING_LINE_COUNT
  );
}

function shouldDisableLiveFormatting(view: EditorView) {
  return shouldDisableLiveFormattingState(view.state);
}

function stripLinkTitleDelimiters(rawTitle: string) {
  const first = rawTitle.at(0);
  const last = rawTitle.at(-1);
  const matchesDelimiter =
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "(" && last === ")");

  return matchesDelimiter ? rawTitle.slice(1, -1) : rawTitle;
}

function parseMarkdownImage(
  view: EditorView,
  from: number,
  to: number,
  syntaxNode: SyntaxNode,
) {
  let url: string | null = null;
  let title: string | null = null;
  let closingAltBracketPos: number | null = null;

  for (let child = syntaxNode.firstChild; child; child = child.nextSibling) {
    const childText = view.state.doc.sliceString(child.from, child.to);
    if (child.type.name === "URL") {
      url = childText.trim();
      continue;
    }

    if (child.type.name === "LinkTitle") {
      title = stripLinkTitleDelimiters(childText.trim());
      continue;
    }

    if (child.type.name === "LinkMark" && childText === "]") {
      closingAltBracketPos = child.from;
    }
  }

  if (!url) {
    return null;
  }

  if (url.startsWith("<") && url.endsWith(">")) {
    url = url.slice(1, -1).trim();
  }

  if (!url) {
    return null;
  }

  const altStart = from + 2;
  const altText =
    closingAltBracketPos !== null && closingAltBracketPos >= altStart
      ? view.state.doc.sliceString(altStart, closingAltBracketPos)
      : "";

  const suffix = view.state.doc.sliceString(to, Math.min(view.state.doc.length, to + 64));
  const parsedWidthToken = parseImageWidthTokenFromText(suffix);
  const replaceTo = parsedWidthToken ? to + parsedWidthToken.consumedChars : to;

  return {
    altText: altText || "image",
    poster: normalizeDocumentMediaUrl(
      parseVideoPosterFromTitle(title) ?? "",
    ) || null,
    replaceTo,
    url: normalizeDocumentMediaUrl(url),
    width: parsedWidthToken?.width ?? null,
  };
}

function selectionIntersectsRange(view: EditorView, from: number, to: number) {
  return selectionIntersectsStateRange(view.state, from, to);
}

function selectionIntersectsStateRange(
  state: EditorState,
  from: number,
  to: number,
) {
  return state.selection.ranges.some((range) => {
    if (range.from === range.to) {
      return range.from >= from && range.from <= to;
    }

    return range.from < to && range.to > from;
  });
}

function selectionIntersectsTableRange(
  state: EditorState,
  from: number,
  to: number,
) {
  return state.selection.ranges.some((range) => {
    if (range.from === range.to) {
      return range.from > from && range.from < to;
    }

    return range.from < to && range.to > from;
  });
}

function selectionIntersectsLine(view: EditorView, position: number) {
  const line = view.state.doc.lineAt(position);
  return selectionIntersectsRange(view, line.from, line.to);
}

function skipLinePrefixWhitespace(view: EditorView, position: number) {
  const line = view.state.doc.lineAt(position);
  let nextPosition = position;

  while (nextPosition < line.to) {
    const nextChar = view.state.doc.sliceString(nextPosition, nextPosition + 1);
    if (nextChar !== " " && nextChar !== "\t") {
      break;
    }
    nextPosition += 1;
  }

  return nextPosition;
}

function addLineClass(
  lineClasses: Map<number, Set<string>>,
  lineFrom: number,
  className: string,
) {
  const classes = lineClasses.get(lineFrom) ?? new Set<string>();
  classes.add(className);
  lineClasses.set(lineFrom, classes);
}

function addLineClassesForRange(
  view: EditorView,
  lineClasses: Map<number, Set<string>>,
  from: number,
  to: number,
  classNames: string[],
) {
  let line = view.state.doc.lineAt(from);

  while (true) {
    for (const className of classNames) {
      addLineClass(lineClasses, line.from, className);
    }

    if (line.to >= to || line.number >= view.state.doc.lines) {
      break;
    }

    line = view.state.doc.line(line.number + 1);
  }
}

function getLineDecoration(className: string) {
  let decoration = lineDecorationCache.get(className);
  if (!decoration) {
    decoration = Decoration.line({ attributes: { class: className } });
    lineDecorationCache.set(className, decoration);
  }

  return decoration;
}

function getLinkDecoration(url: string) {
  let decoration = linkDecorationCache.get(url);
  if (!decoration) {
    decoration = Decoration.mark({
      attributes: {
        "data-href": url,
        title: url,
      },
      class: "cm-md-link",
    });
    linkDecorationCache.set(url, decoration);
  }

  return decoration;
}

function parseMarkdownLink(view: EditorView, syntaxNode: SyntaxNode) {
  let labelFrom: number | null = null;
  let labelTo: number | null = null;
  let url: string | null = null;

  for (let child = syntaxNode.firstChild; child; child = child.nextSibling) {
    const childText = view.state.doc.sliceString(child.from, child.to);

    if (child.type.name === "LinkMark" && childText === "[") {
      labelFrom = child.to;
      continue;
    }

    if (child.type.name === "LinkMark" && childText === "]") {
      labelTo = child.from;
      continue;
    }

    if (child.type.name === "URL") {
      url = childText.trim();
    }
  }

  if (labelFrom === null || labelTo === null || labelFrom > labelTo || !url) {
    return null;
  }

  if (url.startsWith("<") && url.endsWith(">")) {
    url = url.slice(1, -1).trim();
  }

  if (!url) {
    return null;
  }

  return {
    labelFrom,
    labelTo,
    url,
  };
}

function parseInlineCode(syntaxNode: SyntaxNode) {
  let contentFrom: number | null = null;
  let contentTo: number | null = null;

  for (let child = syntaxNode.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "CodeMark") {
      continue;
    }

    if (contentFrom === null) {
      contentFrom = child.to;
      continue;
    }

    contentTo = child.from;
  }

  if (contentFrom === null || contentTo === null || contentFrom > contentTo) {
    return null;
  }

  return {
    contentFrom,
    contentTo,
  };
}

function parseFencedCode(syntaxNode: SyntaxNode) {
  let contentFrom: number | null = null;
  let contentTo: number | null = null;

  for (let child = syntaxNode.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "CodeText") {
      continue;
    }

    if (contentFrom === null) {
      contentFrom = child.from;
    }

    contentTo = child.to;
  }

  if (contentFrom === null || contentTo === null || contentFrom > contentTo) {
    return null;
  }

  return {
    contentFrom,
    contentTo,
  };
}

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  if (shouldDisableLiveFormatting(view)) {
    return Decoration.none;
  }

  const decorations: Range<Decoration>[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Table") {
          if (selectionIntersectsTableRange(view.state, node.from, node.to)) {
            return;
          }

          const source = view.state.doc.sliceString(node.from, node.to);
          return parseMarkdownTable(source) ? false : undefined;
        }

        if (node.name === "StrongEmphasis") {
          decorations.push(strongDecoration.range(node.from, node.to));
          return;
        }

        if (node.name === "Emphasis") {
          decorations.push(emphasisDecoration.range(node.from, node.to));
          return;
        }

        if (node.name === "EmphasisMark") {
          decorations.push(hiddenMarkdownMarkDecoration.range(node.from, node.to));
          return;
        }

        if (node.name.startsWith("ATXHeading")) {
          if (selectionIntersectsRange(view, node.from, node.to)) {
            return;
          }

          const level = Number.parseInt(node.name.slice("ATXHeading".length), 10);
          if (Number.isNaN(level)) {
            return;
          }

          let contentFrom = node.from;

          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.type.name !== "HeaderMark") {
              continue;
            }

            contentFrom = skipLinePrefixWhitespace(view, child.to);
          }

          addLineClassesForRange(view, lineClasses, node.from, node.to, [
            "cm-md-heading-line",
            `cm-md-heading-line-${level}`,
          ]);

          if (contentFrom > node.from) {
            decorations.push(hiddenMarkdownMarkDecoration.range(node.from, contentFrom));
          }

          return;
        }

        if (node.name === "Blockquote") {
          if (selectionIntersectsRange(view, node.from, node.to)) {
            return;
          }

          addLineClassesForRange(view, lineClasses, node.from, node.to, [
            "cm-md-blockquote-line",
          ]);
          return;
        }

        if (node.name === "QuoteMark") {
          if (selectionIntersectsLine(view, node.from)) {
            return;
          }

          const replaceTo = skipLinePrefixWhitespace(view, node.to);
          decorations.push(hiddenMarkdownMarkDecoration.range(node.from, replaceTo));
          return;
        }

        if (node.name === "ListMark") {
          if (selectionIntersectsLine(view, node.from)) {
            return;
          }

          const markerText = view.state.doc.sliceString(node.from, node.to).trim();
          const replaceTo = skipLinePrefixWhitespace(view, node.to);
          const spacingText = view.state.doc.sliceString(node.to, replaceTo) || " ";
          const renderedMarker = /^\d+\.$/.test(markerText) ? markerText : "•";

          decorations.push(
            Decoration.replace({
              widget: new MarkdownListMarkWidget(`${renderedMarker}${spacingText}`),
            }).range(node.from, replaceTo),
          );
          return;
        }

        if (node.name === "Link") {
          if (selectionIntersectsRange(view, node.from, node.to)) {
            return;
          }

          const parsedLink = parseMarkdownLink(view, node.node);
          if (!parsedLink) {
            return;
          }

          const { labelFrom, labelTo, url } = parsedLink;
          if (labelFrom < labelTo) {
            decorations.push(getLinkDecoration(url).range(labelFrom, labelTo));
          }

          decorations.push(hiddenMarkdownMarkDecoration.range(node.from, labelFrom));
          decorations.push(hiddenMarkdownMarkDecoration.range(labelTo, node.to));
          return;
        }

        if (node.name === "InlineCode") {
          if (selectionIntersectsRange(view, node.from, node.to)) {
            return;
          }

          const parsedInlineCode = parseInlineCode(node.node);
          if (!parsedInlineCode) {
            return;
          }

          const { contentFrom, contentTo } = parsedInlineCode;
          decorations.push(hiddenMarkdownMarkDecoration.range(node.from, contentFrom));
          decorations.push(hiddenMarkdownMarkDecoration.range(contentTo, node.to));
          if (contentFrom < contentTo) {
            decorations.push(inlineCodeDecoration.range(contentFrom, contentTo));
          }
          return;
        }

        if (node.name === "FencedCode") {
          if (selectionIntersectsRange(view, node.from, node.to)) {
            return;
          }

          const parsedFencedCode = parseFencedCode(node.node);
          if (!parsedFencedCode) {
            return;
          }

          const { contentFrom, contentTo } = parsedFencedCode;
          decorations.push(hiddenMarkdownMarkDecoration.range(node.from, contentFrom));
          decorations.push(hiddenMarkdownMarkDecoration.range(contentTo, node.to));
          if (contentFrom < contentTo) {
            decorations.push(codeBlockTextDecoration.range(contentFrom, contentTo));
            addLineClassesForRange(view, lineClasses, contentFrom, contentTo, [
              "cm-md-code-block-line",
            ]);
          }
          return;
        }

        if (node.name === "HorizontalRule") {
          if (selectionIntersectsLine(view, node.from)) {
            return;
          }

          decorations.push(
            Decoration.replace({
              widget: new MarkdownHorizontalRuleWidget(),
            }).range(node.from, node.to),
          );
          return;
        }

        if (node.name === "Image") {
          const parsedImage = parseMarkdownImage(view, node.from, node.to, node.node);
          if (!parsedImage) {
            return;
          }

          if (selectionIntersectsRange(view, node.from, parsedImage.replaceTo)) {
            return;
          }

          decorations.push(
            Decoration.replace({
              widget: new MarkdownMediaPreviewWidget(
                parsedImage.url,
                parsedImage.altText,
                parsedImage.width,
                parsedImage.poster,
              ),
            }).range(node.from, parsedImage.replaceTo),
          );
        }
      },
    });
  }

  for (const [lineFrom, classes] of lineClasses) {
    decorations.push(
      getLineDecoration(Array.from(classes).join(" ")).range(lineFrom),
    );
  }

  return Decoration.set(decorations, true);
}

function buildMarkdownTablePreviews(state: EditorState): DecorationSet {
  if (shouldDisableLiveFormattingState(state)) {
    return Decoration.none;
  }

  const decorations: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  const documentSource = state.doc.toString();
  const references = parseMarkdownReferenceDefinitions(
    documentSource,
    tree.topNode,
  );

  tree.iterate({
    enter: (node) => {
      if (node.name !== "Table") {
        return;
      }

      if (selectionIntersectsTableRange(state, node.from, node.to)) {
        return false;
      }

      const source = state.doc.sliceString(node.from, node.to);
      const table = parseMarkdownTable(source, { references });
      if (!table) {
        return false;
      }

      decorations.push(
        Decoration.replace({
          block: true,
          inclusive: false,
          widget: new MarkdownTableWidget(node.from, table),
        }).range(node.from, node.to),
      );
      return false;
    },
  });

  return Decoration.set(decorations, true);
}

const markdownTablePreviews = StateField.define<DecorationSet>({
  create: buildMarkdownTablePreviews,
  update: (decorations, transaction) => {
    const syntaxChanged =
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
    if (transaction.docChanged || transaction.selection || syntaxChanged) {
      return buildMarkdownTablePreviews(transaction.state);
    }

    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const markdownInlineLiveFormatting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    lastDecorationBuildAt: number;

    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view);
      this.lastDecorationBuildAt = getCurrentTimeMs();
    }

    update(update: ViewUpdate) {
      if (shouldDisableLiveFormatting(update.view)) {
        if (this.decorations !== Decoration.none) {
          this.decorations = Decoration.none;
        }
        this.lastDecorationBuildAt = getCurrentTimeMs();
        return;
      }

      if (update.docChanged) {
        this.decorations = buildMarkdownDecorations(update.view);
        this.lastDecorationBuildAt = getCurrentTimeMs();
        return;
      }

      if (
        update.transactions.some((transaction) =>
          transaction.isUserEvent("select.table"),
        )
      ) {
        this.decorations = buildMarkdownDecorations(update.view);
        this.lastDecorationBuildAt = getCurrentTimeMs();
        return;
      }

      if (!update.viewportChanged && !update.selectionSet) {
        return;
      }

      const now = getCurrentTimeMs();
      if (now - this.lastDecorationBuildAt < DECORATION_REBUILD_INTERVAL_MS) {
        return;
      }

      this.lastDecorationBuildAt = now;
      this.decorations = buildMarkdownDecorations(update.view);
    }
  },
  {
    decorations: (instance) => instance.decorations,
  },
);

export const markdownLiveFormatting = [
  markdownTablePreviews,
  markdownInlineLiveFormatting,
];
