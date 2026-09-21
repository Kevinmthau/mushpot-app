import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";

import {
  parseInlineContent,
  type MarkdownInlineContent,
  type MarkdownParseContext,
} from "@/lib/markdown/inline";
import {
  directChildren,
  emptyReferenceDefinitions,
  type MarkdownReferenceDefinitions,
} from "@/lib/markdown/links";

export type MarkdownTableAlignment = "center" | "left" | "right" | null;

export type MarkdownTableCell = {
  content: MarkdownInlineContent[];
  from: number;
};

export type ParsedMarkdownTable = {
  alignments: MarkdownTableAlignment[];
  header: MarkdownTableCell[];
  rows: MarkdownTableCell[][];
  source: string;
};

type MarkdownTableParseOptions = {
  references?: MarkdownReferenceDefinitions;
};

function parseAlignmentRow(
  source: string,
  node: SyntaxNode,
): MarkdownTableAlignment[] {
  let delimiter = source.slice(node.from, node.to).trim();
  if (delimiter.startsWith("|")) {
    delimiter = delimiter.slice(1);
  }
  if (delimiter.endsWith("|")) {
    delimiter = delimiter.slice(0, -1);
  }

  return delimiter.split("|").map((cell) => {
    const value = cell.trim();
    const left = value.startsWith(":");
    const right = value.endsWith(":");

    if (left && right) {
      return "center";
    }
    if (right) {
      return "right";
    }
    if (left) {
      return "left";
    }
    return null;
  });
}

function parseTableCells(
  source: string,
  row: SyntaxNode,
  columnCount: number,
  context: MarkdownParseContext,
) {
  const children = directChildren(row);
  const delimiters = children.filter(
    (child) => child.name === "TableDelimiter",
  );
  const firstDelimiter = delimiters.at(0) ?? null;
  const lastDelimiter = delimiters.at(-1) ?? null;
  const hasLeadingDelimiter = Boolean(
    firstDelimiter &&
      /^[ \t]*$/.test(source.slice(row.from, firstDelimiter.from)),
  );
  const hasTrailingDelimiter = Boolean(
    lastDelimiter &&
      /^[ \t]*$/.test(source.slice(lastDelimiter.to, row.to)),
  );
  const separators = delimiters.slice(
    hasLeadingDelimiter ? 1 : 0,
    delimiters.length - (hasTrailingDelimiter ? 1 : 0),
  );
  const cells: MarkdownTableCell[] = Array.from(
    { length: columnCount },
    (_, index) => {
      const precedingDelimiter =
        index === 0
          ? hasLeadingDelimiter
            ? firstDelimiter
            : null
          : separators[index - 1] ?? null;
      const followingDelimiter =
        separators[index] ?? (hasTrailingDelimiter ? lastDelimiter : null);
      const from =
        precedingDelimiter?.to ??
        (index === 0 ? row.from : followingDelimiter?.from ?? row.to);

      return {
        content: [],
        from: Math.min(from, followingDelimiter?.from ?? row.to),
      };
    },
  );

  let delimitersBeforeCell = 0;
  for (const cell of children) {
    if (cell.name !== "TableCell") {
      continue;
    }
    while (
      delimitersBeforeCell < delimiters.length &&
      delimiters[delimitersBeforeCell].to <= cell.from
    ) {
      delimitersBeforeCell += 1;
    }
    const cellIndex = delimitersBeforeCell - (hasLeadingDelimiter ? 1 : 0);
    if (cellIndex < 0 || cellIndex >= columnCount) {
      continue;
    }

    cells[cellIndex] = {
      content: parseInlineContent(source, cell, context),
      from: cell.from,
    };
  }

  return cells;
}

export function parseMarkdownTable(
  source: string,
  options: MarkdownTableParseOptions = {},
): ParsedMarkdownTable | null {
  const tree = markdownLanguage.parser.parse(source);
  const table = tree.topNode.getChild("Table");
  if (!table) {
    return null;
  }

  if (
    source.slice(0, table.from).trim().length > 0 ||
    source.slice(table.to).trim().length > 0
  ) {
    return null;
  }

  const tableChildren = directChildren(table);
  const headerNode = tableChildren.find((child) => child.name === "TableHeader");
  const alignmentNode = tableChildren.find(
    (child) => child.name === "TableDelimiter",
  );
  if (!headerNode || !alignmentNode) {
    return null;
  }

  const alignments = parseAlignmentRow(source, alignmentNode);
  const columnCount = alignments.length;

  if (columnCount === 0) {
    return null;
  }

  const context: MarkdownParseContext = {
    references: options.references ?? emptyReferenceDefinitions,
  };
  const header = parseTableCells(source, headerNode, columnCount, context);
  const rowNodes = tableChildren.filter((child) => child.name === "TableRow");
  const rows = rowNodes.map((row) =>
    parseTableCells(source, row, columnCount, context),
  );

  return {
    alignments: Array.from(
      { length: columnCount },
      (_, index) => alignments[index] ?? null,
    ),
    header,
    rows,
    source,
  };
}
