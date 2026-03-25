"use client";

import { syntaxTree } from "@codemirror/language";
import { type Range } from "@codemirror/state";
import { type SyntaxNode } from "@lezer/common";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { parseImageWidthTokenFromText } from "@/lib/markdown/image-width";

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

class MarkdownImagePreviewWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly altText: string,
    private readonly width: string | null,
  ) {
    super();
  }

  eq(other: MarkdownImagePreviewWidget) {
    return (
      this.src === other.src &&
      this.altText === other.altText &&
      this.width === other.width
    );
  }

  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-image-preview";
    wrapper.setAttribute("aria-label", this.altText || "Image");

    const image = document.createElement("img");
    image.src = this.src;
    image.alt = this.altText;
    image.loading = "lazy";
    image.decoding = "async";
    image.draggable = false;
    if (this.width) {
      image.style.width = this.width;
    }

    wrapper.appendChild(image);
    return wrapper;
  }
}

const strongDecoration = Decoration.mark({ class: "cm-md-strong" });
const emphasisDecoration = Decoration.mark({ class: "cm-md-emphasis" });
const hiddenMarkdownMarkDecoration = Decoration.replace({
  widget: new HiddenMarkdownMarkWidget(),
});

function getCurrentTimeMs() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function shouldDisableLiveFormatting(view: EditorView) {
  return (
    view.state.doc.length > MAX_LIVE_FORMATTING_DOC_LENGTH ||
    view.state.doc.lines > MAX_LIVE_FORMATTING_LINE_COUNT
  );
}

function parseMarkdownImage(
  view: EditorView,
  from: number,
  to: number,
  syntaxNode: SyntaxNode,
) {
  let url: string | null = null;
  let closingAltBracketPos: number | null = null;

  for (let child = syntaxNode.firstChild; child; child = child.nextSibling) {
    const childText = view.state.doc.sliceString(child.from, child.to);
    if (child.type.name === "URL") {
      url = childText.trim();
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
    replaceTo,
    url,
    width: parsedWidthToken?.width ?? null,
  };
}

function selectionIntersectsRange(view: EditorView, from: number, to: number) {
  return view.state.selection.ranges.some((range) => {
    if (range.from === range.to) {
      return range.from >= from && range.from <= to;
    }

    return range.from < to && range.to > from;
  });
}

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  if (shouldDisableLiveFormatting(view)) {
    return Decoration.none;
  }

  const decorations: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
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
              widget: new MarkdownImagePreviewWidget(
                parsedImage.url,
                parsedImage.altText,
                parsedImage.width,
              ),
            }).range(node.from, parsedImage.replaceTo),
          );
        }
      },
    });
  }

  return Decoration.set(decorations, true);
}

export const markdownLiveFormatting = ViewPlugin.fromClass(
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
