import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { decodeString } from "micromark-util-decode-string";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";

export type MarkdownTableAlignment = "center" | "left" | "right" | null;

export type MarkdownInlineContent =
  | {
      type: "break";
    }
  | {
      children: MarkdownInlineContent[];
      type: "emphasis" | "strikethrough" | "strong";
    }
  | {
      children: MarkdownInlineContent[];
      href: string;
      title: string | null;
      type: "link";
    }
  | {
      altText: string;
      src: string;
      title: string | null;
      type: "media";
    }
  | {
      text: string;
      type: "code";
    }
  | {
      text: string;
      type: "text";
    };

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

export type MarkdownReferenceDefinition = {
  href: string;
  title: string | null;
};

export type MarkdownReferenceDefinitions = ReadonlyMap<
  string,
  MarkdownReferenceDefinition
>;

type MarkdownParseContext = {
  references: MarkdownReferenceDefinitions;
};

type MarkdownTableParseOptions = {
  references?: MarkdownReferenceDefinitions;
};

const emptyReferenceDefinitions: MarkdownReferenceDefinitions = new Map();

function directChildren(node: SyntaxNode) {
  const children: SyntaxNode[] = [];

  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child);
  }

  return children;
}

function appendContent(
  content: MarkdownInlineContent[],
  next: MarkdownInlineContent | MarkdownInlineContent[] | null,
) {
  if (!next) {
    return;
  }

  const additions = Array.isArray(next) ? next : [next];
  for (const addition of additions) {
    if (addition.type === "text" && addition.text.length === 0) {
      continue;
    }

    const previous = content.at(-1);
    if (previous?.type === "text" && addition.type === "text") {
      previous.text += addition.text;
      continue;
    }

    content.push(addition);
  }
}

function parseDelimitedContent(source: string, node: SyntaxNode, markName: string) {
  let contentFrom: number | null = null;
  let contentTo: number | null = null;

  for (const child of directChildren(node)) {
    if (child.name !== markName) {
      continue;
    }

    if (contentFrom === null) {
      contentFrom = child.to;
      continue;
    }

    contentTo = child.from;
  }

  if (contentFrom === null || contentTo === null || contentFrom > contentTo) {
    return source.slice(node.from, node.to);
  }

  let value = source
    .slice(contentFrom, contentTo)
    .replace(/\r\n?|\n/g, " ")
    .replace(/\\\|/g, "|");
  if (
    value.length > 1 &&
    value.startsWith(" ") &&
    value.endsWith(" ") &&
    /[^ ]/.test(value)
  ) {
    value = value.slice(1, -1);
  }

  return value;
}

function stripLinkDestinationDelimiters(rawDestination: string) {
  const trimmedDestination = rawDestination.trim();
  if (
    trimmedDestination.startsWith("<") &&
    trimmedDestination.endsWith(">")
  ) {
    return trimmedDestination.slice(1, -1);
  }

  return trimmedDestination;
}

function stripLinkTitleDelimiters(rawTitle: string) {
  const trimmedTitle = rawTitle.trim();
  const first = trimmedTitle.at(0);
  const last = trimmedTitle.at(-1);
  const hasMatchingDelimiters =
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "(" && last === ")");

  return hasMatchingDelimiters ? trimmedTitle.slice(1, -1) : trimmedTitle;
}

function decodeLinkDestination(rawDestination: string) {
  return decodeString(stripLinkDestinationDelimiters(rawDestination));
}

function decodeLinkTitle(rawTitle: string | null) {
  return rawTitle === null
    ? null
    : decodeString(stripLinkTitleDelimiters(rawTitle));
}

function stripLinkLabelDelimiters(rawLabel: string) {
  return rawLabel.startsWith("[") && rawLabel.endsWith("]")
    ? rawLabel.slice(1, -1)
    : rawLabel;
}

function getReferenceDefinition(
  context: MarkdownParseContext,
  rawReferenceLabel: string,
) {
  return context.references.get(normalizeIdentifier(rawReferenceLabel)) ?? null;
}

function parseLinkContent(
  source: string,
  node: SyntaxNode,
  context: MarkdownParseContext,
) {
  let labelFrom: number | null = null;
  let labelTo: number | null = null;
  let href: string | null = null;
  let rawReferenceLabel: string | null = null;
  let rawTitle: string | null = null;
  let hasInlineDestination = false;

  for (const child of directChildren(node)) {
    const childText = source.slice(child.from, child.to);

    if (child.name === "LinkMark" && childText === "[") {
      labelFrom = child.to;
      continue;
    }

    if (child.name === "LinkMark" && childText === "]") {
      labelTo = child.from;
      continue;
    }

    if (child.name === "URL") {
      href = childText.trim();
      continue;
    }

    if (child.name === "LinkLabel") {
      rawReferenceLabel = stripLinkLabelDelimiters(childText);
      continue;
    }

    if (child.name === "LinkTitle") {
      rawTitle = childText;
      continue;
    }

    if (child.name === "LinkMark" && childText === "(") {
      hasInlineDestination = true;
    }
  }

  if (labelFrom === null || labelTo === null || labelFrom > labelTo) {
    return null;
  }

  const children = parseInlineContent(
    source,
    node,
    context,
    labelFrom,
    labelTo,
  );
  if (hasInlineDestination) {
    return {
      children,
      href: decodeLinkDestination(href ?? ""),
      title: decodeLinkTitle(rawTitle),
      type: "link" as const,
    };
  }

  const visibleLabel = source.slice(labelFrom, labelTo);
  const referenceLabel = rawReferenceLabel || visibleLabel;
  const definition = getReferenceDefinition(context, referenceLabel);
  if (!definition) {
    return {
      text: source.slice(node.from, node.to),
      type: "text" as const,
    };
  }

  return {
    children,
    href: definition.href,
    title: definition.title,
    type: "link" as const,
  };
}

function getInlineText(content: MarkdownInlineContent[]): string {
  return content
    .map((part) => {
      if (part.type === "break") {
        return "\n";
      }
      if (part.type === "code" || part.type === "text") {
        return part.text;
      }
      if (part.type === "media") {
        return part.altText;
      }
      return getInlineText(part.children);
    })
    .join("");
}

function parseImageContent(
  source: string,
  node: SyntaxNode,
  context: MarkdownParseContext,
) {
  let labelFrom: number | null = null;
  let labelTo: number | null = null;
  let href: string | null = null;
  let rawReferenceLabel: string | null = null;
  let rawTitle: string | null = null;
  let hasInlineDestination = false;

  for (const child of directChildren(node)) {
    const childText = source.slice(child.from, child.to);
    if (child.name === "LinkMark" && childText === "![") {
      labelFrom = child.to;
      continue;
    }

    if (child.name === "LinkMark" && childText === "]") {
      labelTo = child.from;
      continue;
    }

    if (child.name === "URL") {
      href = childText;
      continue;
    }

    if (child.name === "LinkLabel") {
      rawReferenceLabel = stripLinkLabelDelimiters(childText);
      continue;
    }

    if (child.name === "LinkTitle") {
      rawTitle = childText;
      continue;
    }

    if (child.name === "LinkMark" && childText === "(") {
      hasInlineDestination = true;
    }
  }

  if (labelFrom === null || labelTo === null || labelFrom > labelTo) {
    return null;
  }

  const altContent = parseInlineContent(
    source,
    node,
    context,
    labelFrom,
    labelTo,
  );
  const altText = getInlineText(altContent);

  if (hasInlineDestination) {
    const src = decodeLinkDestination(href ?? "");
    return src
      ? {
          altText,
          src,
          title: decodeLinkTitle(rawTitle),
          type: "media" as const,
        }
      : null;
  }

  const visibleLabel = source.slice(labelFrom, labelTo);
  const referenceLabel = rawReferenceLabel || visibleLabel;
  const definition = getReferenceDefinition(context, referenceLabel);
  if (!definition) {
    return {
      text: source.slice(node.from, node.to),
      type: "text" as const,
    };
  }

  return definition.href
    ? {
        altText,
        src: definition.href,
        title: definition.title,
        type: "media" as const,
      }
    : null;
}

function parseInlineNode(
  source: string,
  node: SyntaxNode,
  context: MarkdownParseContext,
): MarkdownInlineContent | MarkdownInlineContent[] | null {
  if (
    node.name === "CodeMark" ||
    node.name === "EmphasisMark" ||
    node.name === "LinkMark" ||
    node.name === "SubscriptMark" ||
    node.name === "StrikethroughMark"
  ) {
    return null;
  }

  if (node.name === "StrongEmphasis") {
    return {
      children: parseInlineContent(source, node, context),
      type: "strong",
    };
  }

  if (node.name === "Emphasis") {
    return {
      children: parseInlineContent(source, node, context),
      type: "emphasis",
    };
  }

  if (node.name === "Strikethrough" || node.name === "Subscript") {
    return {
      children: parseInlineContent(source, node, context),
      type: "strikethrough",
    };
  }

  if (node.name === "InlineCode") {
    return {
      text: parseDelimitedContent(source, node, "CodeMark"),
      type: "code",
    };
  }

  if (node.name === "Link") {
    return parseLinkContent(source, node, context);
  }

  if (node.name === "URL") {
    const text = source.slice(node.from, node.to);
    return {
      children: [{ text, type: "text" }],
      href: text.startsWith("www.") ? `https://${text}` : text,
      title: null,
      type: "link",
    };
  }

  if (node.name === "Autolink") {
    const urlNode = directChildren(node).find((child) => child.name === "URL");
    const text = urlNode
      ? source.slice(urlNode.from, urlNode.to)
      : source.slice(node.from + 1, Math.max(node.from + 1, node.to - 1));
    return {
      children: [{ text, type: "text" }],
      href: text.includes("@") ? `mailto:${text}` : text,
      title: null,
      type: "link",
    };
  }

  if (node.name === "Image") {
    return parseImageContent(source, node, context);
  }

  if (node.name === "Escape") {
    return {
      text: source.slice(Math.min(node.from + 1, node.to), node.to),
      type: "text",
    };
  }

  if (node.name === "Entity") {
    const rawEntity = source.slice(node.from, node.to);
    return {
      text: decodeString(rawEntity),
      type: "text",
    };
  }

  if (node.name === "HardBreak" || node.name === "SoftBreak") {
    return { type: "break" };
  }

  if (node.firstChild) {
    return parseInlineContent(source, node, context);
  }

  return {
    text: source.slice(node.from, node.to),
    type: "text",
  };
}

function parseInlineContent(
  source: string,
  parent: SyntaxNode,
  context: MarkdownParseContext,
  from = parent.from,
  to = parent.to,
) {
  const content: MarkdownInlineContent[] = [];
  let position = from;

  for (const child of directChildren(parent)) {
    if (child.to <= from) {
      continue;
    }

    if (child.from >= to) {
      break;
    }

    if (child.from < from || child.to > to) {
      continue;
    }

    if (child.from > position) {
      appendContent(content, {
        text: source.slice(position, child.from),
        type: "text",
      });
    }

    appendContent(content, parseInlineNode(source, child, context));
    position = child.to;
  }

  if (position < to) {
    appendContent(content, {
      text: source.slice(position, to),
      type: "text",
    });
  }

  return content;
}

export function parseMarkdownReferenceDefinitions(
  source: string,
  rootNode: SyntaxNode = markdownLanguage.parser.parse(source).topNode,
) {
  const definitions = new Map<string, MarkdownReferenceDefinition>();
  const cursor = rootNode.cursor();

  do {
    if (cursor.name !== "LinkReference") {
      continue;
    }

    let rawLabel: string | null = null;
    let rawHref: string | null = null;
    let rawTitle: string | null = null;

    for (const child of directChildren(cursor.node)) {
      const childText = source.slice(child.from, child.to);
      if (child.name === "LinkLabel") {
        rawLabel = stripLinkLabelDelimiters(childText);
        continue;
      }
      if (child.name === "URL") {
        rawHref = childText;
        continue;
      }
      if (child.name === "LinkTitle") {
        rawTitle = childText;
      }
    }

    if (rawLabel === null || rawHref === null) {
      continue;
    }

    const identifier = normalizeIdentifier(rawLabel);
    if (definitions.has(identifier)) {
      continue;
    }

    definitions.set(identifier, {
      href: decodeLinkDestination(rawHref),
      title: decodeLinkTitle(rawTitle),
    });
  } while (cursor.next());

  return definitions;
}

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

  for (const cell of children.filter((child) => child.name === "TableCell")) {
    const delimitersBeforeCell = delimiters.filter(
      (delimiter) => delimiter.to <= cell.from,
    ).length;
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
