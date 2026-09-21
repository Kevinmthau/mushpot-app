import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { decodeString } from "micromark-util-decode-string";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";

export type MarkdownReferenceDefinition = {
  href: string;
  title: string | null;
};

export type MarkdownReferenceDefinitions = ReadonlyMap<
  string,
  MarkdownReferenceDefinition
>;

export const emptyReferenceDefinitions: MarkdownReferenceDefinitions = new Map();

export function directChildren(node: SyntaxNode) {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child);
  }
  return children;
}

function decodeDestination(raw: string) {
  const value = raw.trim();
  return decodeString(value.startsWith("<") && value.endsWith(">")
    ? value.slice(1, -1)
    : value);
}

function decodeTitle(raw: string | null) {
  if (raw === null) return null;
  const value = raw.trim();
  const first = value.at(0);
  const last = value.at(-1);
  const delimited = (first === '"' && last === '"') ||
    (first === "'" && last === "'") || (first === "(" && last === ")");
  return decodeString(delimited ? value.slice(1, -1) : value);
}

function stripLabel(raw: string) {
  return raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
}

// The source reader accepts both strings and CodeMirror's persistent Text
// without serializing the document for ordinary inline destinations.
export function parseMarkdownLinkDestination(
  read: (from: number, to: number) => string,
  node: SyntaxNode,
  getReferences: () => MarkdownReferenceDefinitions = () => emptyReferenceDefinitions,
) {
  let labelFrom: number | null = null;
  let labelTo: number | null = null;
  let href: string | null = null;
  let referenceLabel: string | null = null;
  let title: string | null = null;
  let inline = false;

  for (const child of directChildren(node)) {
    const text = read(child.from, child.to);
    if (child.name === "LinkMark") {
      if (text === "[" || text === "![") labelFrom = child.to;
      if (text === "]") labelTo = child.from;
      if (text === "(") inline = true;
    } else if (child.name === "URL" && labelTo !== null) {
      href = text;
    } else if (child.name === "LinkLabel") {
      referenceLabel = stripLabel(text);
    } else if (child.name === "LinkTitle") {
      title = text;
    }
  }

  if (labelFrom === null || labelTo === null || labelFrom > labelTo) return null;
  const destination = inline
    ? { href: decodeDestination(href ?? ""), title: decodeTitle(title) }
    : getReferences().get(normalizeIdentifier(referenceLabel || read(labelFrom, labelTo)));
  return destination ? { ...destination, labelFrom, labelTo } : null;
}

export function parseMarkdownReferenceDefinitions(
  source: string,
  rootNode: SyntaxNode = markdownLanguage.parser.parse(source).topNode,
) {
  const definitions = new Map<string, MarkdownReferenceDefinition>();
  const cursor = rootNode.cursor();
  do {
    if (cursor.name !== "LinkReference") continue;
    let label: string | null = null;
    let href: string | null = null;
    let title: string | null = null;
    for (const child of directChildren(cursor.node)) {
      const text = source.slice(child.from, child.to);
      if (child.name === "LinkLabel") label = stripLabel(text);
      if (child.name === "URL") href = text;
      if (child.name === "LinkTitle") title = text;
    }
    if (label === null || href === null) continue;
    const identifier = normalizeIdentifier(label);
    // CommonMark resolves duplicate definitions to their first occurrence.
    if (!definitions.has(identifier)) {
      definitions.set(identifier, {
        href: decodeDestination(href),
        title: decodeTitle(title),
      });
    }
  } while (cursor.next());
  return definitions;
}
