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

import {
  selectionIntersectsStateRange,
  selectionIntersectsTableRange,
  shouldDisableLiveFormattingState,
} from "@/components/editor/markdown-formatting-context";
import {
  MarkdownMediaPreviewWidget,
  parseMarkdownImage,
} from "@/components/editor/markdown-media-preview";
import { markdownTablePreviews } from "@/components/editor/markdown-table-preview";
import {
  parseMarkdownLinkDestination,
  parseMarkdownReferenceDefinitions,
} from "@/lib/markdown/links";

const DECORATION_REBUILD_INTERVAL_MS = 120;

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

function shouldDisableLiveFormatting(view: EditorView) {
  return shouldDisableLiveFormattingState(view.state);
}

function selectionIntersectsRange(view: EditorView, from: number, to: number) {
  return selectionIntersectsStateRange(view.state, from, to);
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

function addLinkLabelUrlEscapes(
  view: EditorView,
  syntaxNode: SyntaxNode,
  labelFrom: number,
  labelTo: number,
  decorations: Range<Decoration>[],
) {
  syntaxNode.cursor().iterate((node) => {
    if (/^(InlineCode|Image|Autolink|HTMLTag)$/.test(node.name)) {
      return false;
    }

    if (node.name !== "URL") {
      return;
    }

    if (node.from >= labelFrom && node.to <= labelTo) {
      // GFM autolinking absorbs escapes into URL nodes inside link labels,
      // so they do not have the Escape children handled by the main traversal.
      const source = view.state.doc.sliceString(node.from, node.to);
      for (const match of source.matchAll(/\\[!-/:-@[-`{-~]/g)) {
        const from = node.from + match.index;
        decorations.push(hiddenMarkdownMarkDecoration.range(from, from + 1));
      }
    }

    return false;
  });
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

function hideMarkdownWithoutLineBreaks(
  view: EditorView,
  from: number,
  to: number,
  decorations: Range<Decoration>[],
) {
  // ViewPlugin replacements cannot span line breaks. Preserve those breaks
  // when hiding link syntax or code fences and their language labels.
  while (from < to) {
    const line = view.state.doc.lineAt(from);
    const end = Math.min(to, line.to);
    if (from < end) decorations.push(hiddenMarkdownMarkDecoration.range(from, end));
    from = line.to + 1;
  }
}

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  if (shouldDisableLiveFormatting(view)) {
    return Decoration.none;
  }

  const decorations: Range<Decoration>[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const tree = syntaxTree(view.state);
  let references = view.state.field(markdownTablePreviews).references;
  const getReferences = () => references ??= parseMarkdownReferenceDefinitions(
    view.state.doc.toString(), tree.topNode,
  );

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Table") {
          if (selectionIntersectsTableRange(view.state, node.from, node.to)) {
            return;
          }

          const table = view.state.field(markdownTablePreviews).tables.find(
            (table) => table.from === node.from && table.to === node.to,
          );
          return table?.preview ? false : undefined;
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

        if (
          node.name === "Escape" &&
          !selectionIntersectsRange(view, node.from, node.to)
        ) {
          decorations.push(
            hiddenMarkdownMarkDecoration.range(node.from, node.from + 1),
          );
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

          const parsedLink = parseMarkdownLinkDestination(
            (from, to) => view.state.doc.sliceString(from, to), node.node, getReferences,
          );
          if (!parsedLink) {
            return;
          }

          const { labelFrom, labelTo, href: url } = parsedLink;
          if (labelFrom < labelTo) {
            decorations.push(getLinkDecoration(url).range(labelFrom, labelTo));
            addLinkLabelUrlEscapes(
              view,
              node.node,
              labelFrom,
              labelTo,
              decorations,
            );
          }

          hideMarkdownWithoutLineBreaks(view, node.from, labelFrom, decorations);
          hideMarkdownWithoutLineBreaks(view, labelTo, node.to, decorations);
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
          hideMarkdownWithoutLineBreaks(view, node.from, contentFrom, decorations);
          hideMarkdownWithoutLineBreaks(view, contentTo, node.to, decorations);
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
          // A media widget replaces the entire image source. Keep multiline
          // images editable as source instead of consuming a line break from
          // a ViewPlugin decoration, which would crash the editor.
          if (
            view.state.doc.lineAt(node.from).number !==
            view.state.doc.lineAt(node.to).number
          ) {
            return false;
          }

          const parsedImage = parseMarkdownImage(view, node.node, getReferences);
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
          return false;
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

export const markdownInlineLiveFormatting = ViewPlugin.fromClass(
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
