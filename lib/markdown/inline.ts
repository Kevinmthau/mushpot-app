import type { SyntaxNode } from "@lezer/common";
import { decodeString } from "micromark-util-decode-string";

import { parseImageWidthTokenFromText } from "@/lib/markdown/image-width";
import {
  directChildren,
  parseMarkdownLinkDestination,
  type MarkdownReferenceDefinitions,
} from "@/lib/markdown/links";

type MarkdownSource = { slice(from: number, to: number): string };
export type MarkdownParseContext = { references: MarkdownReferenceDefinitions };

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
      width?: string;
    }
  | {
      text: string;
      type: "code";
    }
  | {
      text: string;
      type: "text";
    };

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

function parseDelimitedContent(source: MarkdownSource, node: SyntaxNode, markName: string) {
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

function parseLinkContent(
  source: MarkdownSource,
  node: SyntaxNode,
  context: MarkdownParseContext,
) {
  const link = parseMarkdownLinkDestination(
    (from, to) => source.slice(from, to), node, () => context.references,
  );
  if (!link) return { text: source.slice(node.from, node.to), type: "text" as const };
  return {
    children: parseInlineContent(source, node, context, link.labelFrom, link.labelTo),
    href: link.href,
    title: link.title,
    type: "link" as const,
  };
}

export function getInlineText(content: MarkdownInlineContent[]): string {
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
  source: MarkdownSource,
  node: SyntaxNode,
  context: MarkdownParseContext,
) {
  const image = parseMarkdownLinkDestination(
    (from, to) => source.slice(from, to), node, () => context.references,
  );
  if (!image) return { text: source.slice(node.from, node.to), type: "text" as const };
  if (!image.href) return null;
  return {
    altText: getInlineText(parseInlineContent(
      source, node, context, image.labelFrom, image.labelTo,
    )),
    src: image.href,
    title: image.title,
    type: "media" as const,
  };
}

function parseInlineNode(
  source: MarkdownSource,
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

export function parseInlineContent(
  source: MarkdownSource,
  parent: SyntaxNode,
  context: MarkdownParseContext,
  from = parent.from,
  to = parent.to,
) {
  const content: MarkdownInlineContent[] = [];
  let position = from;

  for (const child of directChildren(parent)) {
    if (child.to <= position) {
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

    const parsed = parseInlineNode(source, child, context);
    position = child.to;
    if (parsed && !Array.isArray(parsed) && parsed.type === "media") {
      const token = parseImageWidthTokenFromText(source.slice(position, to));
      if (token) {
        parsed.width = token.width;
        position += token.consumedChars;
      }
    }
    appendContent(content, parsed);
  }

  if (position < to) {
    appendContent(content, {
      text: source.slice(position, to),
      type: "text",
    });
  }

  return content;
}
