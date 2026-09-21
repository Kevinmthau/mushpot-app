import { syntaxTree } from "@codemirror/language";
import {
  EditorState, StateField, Transaction, type Range,
} from "@codemirror/state";
import {
  Decoration, type DecorationSet, EditorView, WidgetType,
} from "@codemirror/view";

import {
  selectionIntersectsTableRange,
  shouldDisableLiveFormattingState,
} from "@/components/editor/markdown-formatting-context";
import { createMarkdownMediaPreviewElement } from "@/components/editor/markdown-media-preview";
import type { MarkdownInlineContent } from "@/lib/markdown/inline";
import { normalizeDocumentMediaUrl } from "@/lib/document-media";
import { parseVideoPosterFromTitle } from "@/lib/markdown/video-poster";
import {
  parseMarkdownReferenceDefinitions,
  type MarkdownReferenceDefinitions,
} from "@/lib/markdown/links";
import {
  parseMarkdownTable,
  type MarkdownTableAlignment,
  type MarkdownTableCell,
  type ParsedMarkdownTable,
} from "@/lib/markdown/table";

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
          part.width ?? null,
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
      element.dataset.href = part.href;
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

  constructor(private readonly table: ParsedMarkdownTable) {
    super();
    this.renderKey = JSON.stringify(table);
  }

  eq(other: MarkdownTableWidget) {
    return this.renderKey === other.renderKey;
  }

  private revealSource(
    view: EditorView,
    wrapper: HTMLElement,
    target?: EventTarget | null,
  ) {
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
      // A reused widget can move when text before it changes. Read its current
      // position from CodeMirror instead of retaining the creation offset.
      view.posAtDOM(wrapper) + relativePosition,
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
      this.revealSource(view, wrapper, event.target);
    });
    wrapper.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      this.revealSource(view, wrapper, event.target);
    });

    return wrapper;
  }
}

type MarkdownTablePreview = {
  from: number;
  to: number;
  // Undefined defers parsing a table whose source is currently being edited.
  preview?: Range<Decoration> | null;
};

type MarkdownTablePreviewState = {
  decorations: DecorationSet;
  references: MarkdownReferenceDefinitions | null;
  tables: MarkdownTablePreview[];
  visiblePreviews: Range<Decoration>[];
};

function buildMarkdownTablePreviews(
  state: EditorState,
  previous?: MarkdownTablePreviewState,
): MarkdownTablePreviewState {
  if (shouldDisableLiveFormattingState(state)) {
    return {
      decorations: Decoration.none,
      references: null,
      tables: [],
      visiblePreviews: [],
    };
  }

  const candidates = previous?.tables ?? [];
  if (!previous) {
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name !== "Table") {
          return;
        }

        candidates.push({ from: node.from, to: node.to });
        return false;
      },
    });
  }

  let references = previous?.references ?? null;
  const visiblePreviews: Range<Decoration>[] = [];
  const tables = candidates.map((candidate) => {
    const { from, to } = candidate;
    if (selectionIntersectsTableRange(state, from, to)) {
      return candidate;
    }

    let { preview } = candidate;
    if (preview === undefined) {
      // Selection-only updates reuse reference definitions and parsed widgets.
      // Documents without tables never need full-text serialization here.
      references ??= parseMarkdownReferenceDefinitions(
        state.doc.toString(),
        syntaxTree(state).topNode,
      );
      const source = state.doc.sliceString(from, to);
      const table = parseMarkdownTable(source, { references });
      preview = table
        ? Decoration.replace({
            block: true,
            inclusive: false,
            widget: new MarkdownTableWidget(table),
          }).range(from, to)
        : null;
    }
    if (preview) {
      visiblePreviews.push(preview);
    }
    return preview === candidate.preview ? candidate : { from, to, preview };
  });

  const visibilityUnchanged =
    previous &&
    visiblePreviews.length === previous.visiblePreviews.length &&
    visiblePreviews.every(
      (preview, index) => preview === previous.visiblePreviews[index],
    );

  return {
    decorations: visibilityUnchanged
      ? previous.decorations
      : Decoration.set(visiblePreviews, true),
    references,
    tables,
    visiblePreviews,
  };
}

export const markdownTablePreviews = StateField.define<MarkdownTablePreviewState>({
  create: buildMarkdownTablePreviews,
  update: (previews, transaction) => {
    const syntaxChanged =
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
    if (transaction.docChanged || syntaxChanged) {
      return buildMarkdownTablePreviews(transaction.state);
    }
    if (transaction.selection) {
      return buildMarkdownTablePreviews(transaction.state, previews);
    }
    return previews;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (previews) => previews.decorations),
});
