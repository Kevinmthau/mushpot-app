"use client";

import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Prec,
  StateField,
  Transaction,
  type ChangeSet,
  type Text,
  type TextIterator,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  parse as parseHtmlInertly,
  serialize as serializeParsedHtml,
  type DefaultTreeAdapterTypes,
} from "parse5";

import {
  createMarkdownContextScanBudget,
  getStandaloneHttpUrlPaste,
  isLiteralMarkdownInsertionContext,
  MAX_CONTEXTUAL_PASTE_RANGES,
  markdownLinkPasteApplication,
  type MarkdownContextScanBudget,
} from "@/components/editor/markdown-link-paste";
import {
  normalizeMarkdownImageWidth,
  parseImageWidthTokenFromText,
} from "@/lib/markdown/image-width";

type InlineContext = {
  activeFormatting?: ReadonlySet<InlineFormattingKind>;
  boundaryAfter?: string;
  boundaryBefore?: string;
  emphasisMarker?: "*" | "_";
  flattenBreaks?: boolean;
  tableCell?: boolean;
};

type InlineFormattingKind = "code" | "delete" | "emphasis" | "strong";

const MAX_PASTED_TABLE_COLUMNS = 100;
const MAX_PASTED_DOM_DEPTH = 512;
const MAX_PASTED_DOM_NODES = 5_000;
const MAX_PASTED_HTML_ATTRIBUTES = 2_000;
const MAX_PASTED_TEXT_LENGTH = 1_000_000;
const MAX_MARKDOWN_BOUNDARY_CONTEXT_LENGTH = 100_000;
const MAX_BLOCK_BOUNDARY_SCAN_LENGTH = 100_000;
const MAX_CONTEXTUAL_REPLACEMENT_RANGES = 8;
const CLIPBOARD_RESOURCE_ATTRIBUTE_PREFIX = "data-mushpot-clipboard-resource-";
const CLIPBOARD_STYLE_ATTRIBUTE = `${CLIPBOARD_RESOURCE_ATTRIBUTE_PREFIX}style`;
const safeClipboardAttributeNames = new Set([
  "align",
  "alt",
  "checked",
  "class",
  "colspan",
  "height",
  "hidden",
  "open",
  "popover",
  "reversed",
  "rowspan",
  "scope",
  "start",
  "title",
  "type",
  "value",
  "width",
]);
const tableCellBlockTagPattern =
  /^(?:address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|legend|li|main|menu|nav|ol|p|pre|search|section|summary|table|ul)$/;
const blockElementTagPattern =
  /^(?:address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|legend|main|menu|nav|ol|p|pre|search|section|summary|table|ul)$/;
const rawHtmlVoidElementNames = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const rawHtmlTextElementNames = new Set([
  "iframe",
  "noembed",
  "noframes",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);
const rawHtmlParagraphClosingStartTagNames = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "dialog",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "table",
  "ul",
]);
const rawHtmlHeadingElementNames = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const rawHtmlDescriptionElementNames = new Set(["dd", "dt"]);
const rawHtmlRubyTextElementNames = new Set(["rp", "rt"]);
const rawHtmlTableCellElementNames = new Set(["td", "th"]);
const rawHtmlTableSectionElementNames = new Set(["tbody", "tfoot", "thead"]);

function closeRawHtmlOpenElement(
  openElements: string[],
  target: string | ReadonlySet<string>,
) {
  for (let index = openElements.length - 1; index >= 0; index -= 1) {
    if (
      typeof target === "string"
        ? openElements[index] === target
        : target.has(openElements[index])
    ) {
      openElements.length = index;
      return;
    }
  }
}

function applyRawHtmlImpliedEndTags(
  openElements: string[],
  startTagName: string,
) {
  if (rawHtmlParagraphClosingStartTagNames.has(startTagName)) {
    closeRawHtmlOpenElement(openElements, "p");
  }
  if (rawHtmlHeadingElementNames.has(startTagName)) {
    closeRawHtmlOpenElement(openElements, rawHtmlHeadingElementNames);
  }

  if (startTagName === "li") {
    closeRawHtmlOpenElement(openElements, "li");
  } else if (startTagName === "dt" || startTagName === "dd") {
    closeRawHtmlOpenElement(openElements, rawHtmlDescriptionElementNames);
  } else if (startTagName === "rt" || startTagName === "rp") {
    closeRawHtmlOpenElement(openElements, rawHtmlRubyTextElementNames);
  } else if (startTagName === "option") {
    closeRawHtmlOpenElement(openElements, "option");
  } else if (startTagName === "optgroup") {
    closeRawHtmlOpenElement(openElements, "option");
    closeRawHtmlOpenElement(openElements, "optgroup");
  } else if (startTagName === "tr") {
    closeRawHtmlOpenElement(openElements, rawHtmlTableCellElementNames);
    closeRawHtmlOpenElement(openElements, "tr");
  } else if (startTagName === "td" || startTagName === "th") {
    closeRawHtmlOpenElement(openElements, rawHtmlTableCellElementNames);
  } else if (rawHtmlTableSectionElementNames.has(startTagName)) {
    closeRawHtmlOpenElement(openElements, rawHtmlTableCellElementNames);
    closeRawHtmlOpenElement(openElements, "tr");
    closeRawHtmlOpenElement(openElements, rawHtmlTableSectionElementNames);
  } else if (startTagName === "colgroup") {
    closeRawHtmlOpenElement(openElements, "colgroup");
  } else if (startTagName === "a" || startTagName === "button") {
    closeRawHtmlOpenElement(openElements, startTagName);
  } else if (startTagName === "body") {
    closeRawHtmlOpenElement(openElements, "head");
  }
}

function rawHtmlCommentEnd(html: string, contentStart: number) {
  let candidate = html.indexOf(">", contentStart);
  while (candidate >= 0) {
    if (
      candidate === contentStart ||
      (candidate === contentStart + 1 && html[contentStart] === "-") ||
      html.slice(candidate - 2, candidate) === "--" ||
      html.slice(candidate - 3, candidate) === "--!"
    ) {
      return candidate + 1;
    }
    candidate = html.indexOf(">", candidate + 1);
  }
  return html.length;
}

function rawHtmlTagEnd(html: string, start: number) {
  type TagState =
    | "after-attribute-name"
    | "attribute-name"
    | "before-attribute"
    | "before-value"
    | "quoted-value"
    | "unquoted-value";
  let quote: '"' | "'" | null = null;
  let state: TagState = "before-attribute";

  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (state === "quoted-value") {
      if (character === quote) {
        quote = null;
        state = "before-attribute";
      }
      continue;
    }
    if (character === ">") return index;

    if (state === "before-attribute") {
      if (/\s/.test(character) || character === "/") continue;
      state = "attribute-name";
    } else if (state === "attribute-name") {
      if (/\s/.test(character)) {
        state = "after-attribute-name";
      } else if (character === "=") {
        state = "before-value";
      }
    } else if (state === "after-attribute-name") {
      if (/\s/.test(character)) continue;
      state = character === "=" ? "before-value" : "attribute-name";
    } else if (state === "before-value") {
      if (/\s/.test(character)) continue;
      if (character === '"' || character === "'") {
        quote = character;
        state = "quoted-value";
      } else {
        state = "unquoted-value";
      }
    } else if (/\s/.test(character)) {
      state = "before-attribute";
    }
  }
  return -1;
}

function exceedsRawHtmlStructureBudget(html: string) {
  const openElements: string[] = [];
  let elementCount = 0;
  let index = 0;
  let textElement: string | null = null;

  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart < 0) break;
    index = tagStart + 1;

    if (textElement) {
      if (html[index] !== "/") continue;
      let nameEnd = index + 1;
      while (/[A-Za-z0-9:-]/.test(html[nameEnd] ?? "")) nameEnd += 1;
      const name = html.slice(index + 1, nameEnd).toLowerCase();
      if (
        name !== textElement ||
        !/[\t\n\f\r />]/.test(html[nameEnd] ?? "")
      ) {
        continue;
      }
    } else if (html.startsWith("!--", index)) {
      index = rawHtmlCommentEnd(html, index + 3);
      continue;
    } else if (html[index] === "!" || html[index] === "?") {
      const declarationEnd = html.indexOf(">", index + 1);
      index = declarationEnd < 0 ? html.length : declarationEnd + 1;
      continue;
    }

    const closing = html[index] === "/";
    const nameStart = index + (closing ? 1 : 0);
    if (!/[A-Za-z]/.test(html[nameStart] ?? "")) continue;
    let nameEnd = nameStart + 1;
    while (
      nameEnd < html.length &&
      !/[\t\n\f\r />]/.test(html[nameEnd])
    ) {
      nameEnd += 1;
    }
    const tagName = html.slice(nameStart, nameEnd).toLowerCase();

    const tagEnd = rawHtmlTagEnd(html, nameEnd);
    if (tagEnd < 0) break;
    index = tagEnd + 1;

    if (closing) {
      closeRawHtmlOpenElement(openElements, tagName);
      if (tagName === textElement) textElement = null;
      continue;
    }

    elementCount += 1;
    if (elementCount > MAX_PASTED_DOM_NODES) return true;
    applyRawHtmlImpliedEndTags(openElements, tagName);
    if (rawHtmlVoidElementNames.has(tagName)) continue;
    openElements.push(tagName);
    if (openElements.length > MAX_PASTED_DOM_DEPTH) return true;
    if (tagName === "plaintext") break;
    if (rawHtmlTextElementNames.has(tagName)) textElement = tagName;
  }

  return false;
}

function exceedsRawHtmlAttributeBudget(html: string) {
  let attributeCount = 0;
  let index = 0;

  while (index < html.length) {
    if (html[index] !== "<" || !/[A-Za-z]/.test(html[index + 1] ?? "")) {
      index += 1;
      continue;
    }

    index += 2;
    while (index < html.length && !/[\t\n\f\r />]/.test(html[index])) {
      index += 1;
    }

    while (index < html.length) {
      while (/\s/.test(html[index] ?? "")) index += 1;
      if (html[index] === ">") {
        index += 1;
        break;
      }
      if (html[index] === "/" && html[index + 1] === ">") {
        index += 2;
        break;
      }
      if (html[index] === "/") {
        index += 1;
        continue;
      }
      if (index >= html.length || html[index] === "<") break;

      attributeCount += 1;
      if (attributeCount > MAX_PASTED_HTML_ATTRIBUTES) return true;

      while (
        index < html.length &&
        !/[\t\n\f\r =>/]/.test(html[index])
      ) {
        index += 1;
      }
      while (/\s/.test(html[index] ?? "")) index += 1;
      if (html[index] !== "=") continue;

      index += 1;
      while (/\s/.test(html[index] ?? "")) index += 1;
      const quote = html[index] === '"' || html[index] === "'"
        ? html[index++]
        : null;
      if (quote) {
        while (index < html.length && html[index] !== quote) index += 1;
        if (html[index] === quote) index += 1;
      } else {
        while (
          index < html.length &&
          !/[\t\n\f\r >]/.test(html[index])
        ) {
          index += 1;
        }
      }
    }
  }

  return false;
}

function inertClipboardHtml(html: string) {
  if (
    exceedsRawHtmlStructureBudget(html) ||
    exceedsRawHtmlAttributeBudget(html)
  ) {
    return null;
  }
  const parsed = parseHtmlInertly(html, { scriptingEnabled: false });
  const pending: DefaultTreeAdapterTypes.Node[] = [parsed];
  let hasAmbiguousNoscript = false;
  let hasForeignContent = false;
  let hasStylesheet = false;
  let nodeCount = 0;
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodeCount += 1;
    if (nodeCount > MAX_PASTED_DOM_NODES) return null;
    if ("attrs" in node) {
      if (node.namespaceURI !== "http://www.w3.org/1999/xhtml") {
        hasForeignContent = true;
      }
      const originalAttributes = node.attrs.filter(
        (attribute) =>
          !attribute.name.startsWith(CLIPBOARD_RESOURCE_ATTRIBUTE_PREFIX),
      );
      if (node.tagName === "noscript") hasAmbiguousNoscript = true;
      if (node.tagName === "style") hasStylesheet = true;
      if (node.tagName === "pre") {
        const firstChild = node.childNodes[0];
        if (
          firstChild?.nodeName === "#text" &&
          "value" in firstChild &&
          firstChild.value.startsWith("\n")
        ) {
          firstChild.value = `\n${firstChild.value}`;
        }
      }
      if (
        node.tagName === "link" &&
        originalAttributes
          .find((attribute) => attribute.name === "rel")
          ?.value.toLowerCase()
          .split(/\s+/)
          .includes("stylesheet")
      ) {
        hasStylesheet = true;
      }
      node.attrs = [];
      for (const attribute of originalAttributes) {
        if (attribute.namespace || attribute.prefix) continue;
        if (attribute.name === "style") {
          node.attrs.push({
            name: CLIPBOARD_STYLE_ATTRIBUTE,
            value: attribute.value,
          });
        } else if (
          node.tagName === "img" &&
          (attribute.name === "src" || attribute.name === "srcset")
        ) {
          node.attrs.push({
            name: `${CLIPBOARD_RESOURCE_ATTRIBUTE_PREFIX}${attribute.name}`,
            value: attribute.value,
          });
        } else if (
          attribute.name === "href" &&
          (node.tagName === "a" ||
            (node.tagName === "base" &&
              node.namespaceURI === "http://www.w3.org/1999/xhtml"))
        ) {
          node.attrs.push(attribute);
        } else if (safeClipboardAttributeNames.has(attribute.name)) {
          node.attrs.push(attribute);
        }
      }
      if ("content" in node) pending.push(node.content);
    }
    if ("childNodes" in node) pending.push(...node.childNodes);
  }
  return hasStylesheet || hasAmbiguousNoscript || hasForeignContent
    ? null
    : serializeParsedHtml(parsed, { scriptingEnabled: false });
}

function clipboardResourceAttribute(element: Element, name: string) {
  return element.getAttribute(`${CLIPBOARD_RESOURCE_ATTRIBUTE_PREFIX}${name}`);
}

function setClipboardResourceAttribute(
  element: Element,
  name: string,
  value: string,
) {
  element.setAttribute(`${CLIPBOARD_RESOURCE_ATTRIBUTE_PREFIX}${name}`, value);
}

function clipboardStyleAttribute(element: Element) {
  return element.getAttribute(CLIPBOARD_STYLE_ATTRIBUTE);
}

function elementsWithClipboardStyle(root: Element) {
  return [
    root,
    ...Array.from(root.querySelectorAll(`[${CLIPBOARD_STYLE_ATTRIBUTE}]`)),
  ];
}

const meaningfulRichTextSelector = [
  "a[href]",
  "blockquote",
  "b",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "i",
  "img",
  'input[type="checkbox"]',
  "menu",
  "ol",
  "pre",
  "s",
  "strike",
  "strong",
  "table",
  "ul",
  "hr",
].join(",");

const blockRichTextSelector = [
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "menu",
  "ol",
  "pre",
  "table",
  "ul",
].join(",");

function escapeInlineText(text: string, { tableCell = false }: InlineContext = {}) {
  const normalized = text.replace(/[\t\n\f\r ]+/g, " ");
  const escaped = normalized
    .replace(/[!\\`*_[\]{}<>&~]/g, "\\$&")
    .replace(/\b([a-z][a-z\d+.-]*):(?=\/\/)/gi, "$1\\:")
    .replace(/\bwww\./gi, (value) => `${value.slice(0, -1)}\\.`)
    .replace(/@/g, "\\@");
  return tableCell ? escaped.replace(/\|/g, "\\|") : escaped;
}

function escapeMarkdownBlockStarts(value: string) {
  const sourceLines = value.split("\n");
  return sourceLines
    .map((line) => {
      const escaped = line
        .replace(/^( {0,3})(#{1,6})(?=[ \t]|$)/, "$1\\$2")
        .replace(/^( {0,3})(>)/, "$1\\$2")
        .replace(/^( {0,3})([-+])(?=[ \t]|$)/, "$1\\$2")
        .replace(/^( {0,3}\d{1,9})([.)])(?=[ \t]|$)/, "$1\\$2")
        .replace(/^( {0,3})(--+(?:[ \t]+-+)*)([ \t]*)$/, "$1\\$2$3")
        .replace(/^( {0,3})(=+)([ \t]*)$/, "$1\\$2$3");
      if (isMarkdownTableDelimiterRow(line)) {
        return escaped.replace("|", "\\|");
      }
      return escaped;
    })
    .join("\n");
}

function isMarkdownTableDelimiterRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split("|");
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function splitInlineBoundaries(content: string) {
  let start = 0;
  while (start < content.length) {
    if (content.startsWith("\\\n", start)) {
      start += 2;
    } else if (/\s/.test(content[start])) {
      start += 1;
    } else {
      break;
    }
  }

  let end = content.length;
  while (end > start) {
    if (end >= 2 && content.slice(end - 2, end) === "\\\n") {
      end -= 2;
    } else if (/\s/.test(content[end - 1])) {
      end -= 1;
    } else {
      break;
    }
  }

  return {
    leading: content.slice(0, start),
    trailing: content.slice(end),
    value: content.slice(start, end),
  };
}

function trimSerializedMarkdown(value: string) {
  let start = 0;
  while (start < value.length && /[\t\n\f\r ]/.test(value[start])) {
    start += 1;
  }
  return trimSerializedMarkdownEnd(value.slice(start));
}

function trimSerializedMarkdownEnd(value: string) {
  let end = value.length;
  while (end > 0) {
    if (end >= 2 && value.slice(end - 2, end) === "\\\n") {
      end -= 2;
    } else if (/[\t\n\f\r ]/.test(value[end - 1])) {
      end -= 1;
    } else {
      break;
    }
  }
  return value.slice(0, end);
}

function appendInlinePiece(pieces: string[], value: string) {
  if (!value) return;
  const previous = pieces.at(-1);
  if (previous?.endsWith("\n")) {
    value = value.replace(/^[\t\n\f\r ]+/, "");
  } else if (previous && /[\t\f\r ]$/.test(previous)) {
    value = value.replace(/^[\t\f\r ]+/, "");
  }
  if (value) pieces.push(value);
}

function isMarkdownWhitespace(character: string) {
  return !character || /\s/u.test(character);
}

function isMarkdownPunctuation(character: string) {
  return Boolean(character) && /[\p{P}\p{S}]/u.test(character);
}

function canWrapInline(
  value: string,
  leading: string,
  trailing: string,
  before: string,
  after: string,
  marker: string,
) {
  const openingBefore = leading.at(-1) ?? before;
  const openingAfter = value[0] ?? "";
  const closingBefore = value.at(-1) ?? "";
  const closingAfter = trailing[0] ?? after;
  const leftFlanking =
    !isMarkdownWhitespace(openingAfter) &&
    (!isMarkdownPunctuation(openingAfter) ||
      isMarkdownWhitespace(openingBefore) ||
      isMarkdownPunctuation(openingBefore));
  const rightFlanking =
    !isMarkdownWhitespace(closingBefore) &&
    (!isMarkdownPunctuation(closingBefore) ||
      isMarkdownWhitespace(closingAfter) ||
      isMarkdownPunctuation(closingAfter));
  if (marker[0] !== "_") return leftFlanking && rightFlanking;

  const openingRightFlanking =
    !isMarkdownWhitespace(openingBefore) &&
    (!isMarkdownPunctuation(openingBefore) ||
      isMarkdownWhitespace(openingAfter) ||
      isMarkdownPunctuation(openingAfter));
  const closingLeftFlanking =
    !isMarkdownWhitespace(closingAfter) &&
    (!isMarkdownPunctuation(closingAfter) ||
      isMarkdownWhitespace(closingBefore) ||
      isMarkdownPunctuation(closingBefore));
  return (
    leftFlanking &&
    rightFlanking &&
    (!openingRightFlanking || isMarkdownPunctuation(openingBefore)) &&
    (!closingLeftFlanking || isMarkdownPunctuation(closingAfter))
  );
}

function wrapInline(
  content: string,
  marker: string,
  before = "",
  after = "",
) {
  const { leading, trailing, value } = splitInlineBoundaries(content);
  const wrapsNestedUnderscoreEmphasis =
    marker === "**" && value.startsWith("_") && value.endsWith("_");
  return value &&
    (wrapsNestedUnderscoreEmphasis ||
      canWrapInline(value, leading, trailing, before, after, marker))
    ? `${leading}${marker}${value}${marker}${trailing}`
    : content;
}

function markdownLinkDestination(href: string) {
  const value = href
    .trim()
    .replace(/[\u0000-\u0020\u007f<>]/g, (character) =>
      encodeURIComponent(character),
    )
    .replace(/\\/g, "%5C")
    .replace(/&/g, "&amp;")
    .replace(/\|/g, "%7C");
  return /[()]/.test(value) ? `<${value.replace(/>/g, "%3E")}>` : value;
}

function isSafeMarkdownDestination(value: string, media: boolean) {
  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(value.trim())?.[1]?.toLowerCase();
  if (!protocol) return true;
  return media
    ? protocol === "http" || protocol === "https"
    : ["http", "https", "irc", "ircs", "mailto", "xmpp"].includes(protocol);
}

function markdownLinkTitle(value: string, { tableCell = false }: InlineContext = {}) {
  const normalized = value.replace(/[\t\n\f\r ]+/g, " ");
  const escaped = normalized
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/&/g, "&amp;");
  return tableCell ? escaped.replace(/\|/g, "\\|") : escaped;
}

function decodeCssEscapes(value: string) {
  return value.replace(
    /\\(?:([\da-f]{1,6})[ \t\r\n\f]?|(.))/gi,
    (_match, hexadecimal: string | undefined, escaped: string | undefined) => {
      if (!hexadecimal) return escaped ?? "";
      const codePoint = Number.parseInt(hexadecimal, 16);
      return codePoint === 0 || codePoint > 0x10ffff
        ? "\uFFFD"
        : String.fromCodePoint(codePoint);
    },
  );
}

function splitCssDeclarations(value: string) {
  const declarations: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  const blocks: string[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === "\\" && index + 1 < value.length) {
        current += value[++index];
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && value[index + 1] === "*") {
      const commentEnd = value.indexOf("*/", index + 2);
      index = commentEnd < 0 ? value.length : commentEnd + 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\\" && index + 1 < value.length) {
      current += character + value[++index];
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      blocks.push(character);
      current += character;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      const opening = character === ")" ? "(" : character === "]" ? "[" : "{";
      if (blocks.at(-1) === opening) blocks.pop();
      current += character;
      continue;
    }
    if (character === ";" && blocks.length === 0) {
      declarations.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  declarations.push(current);
  return declarations;
}

type InlineStyleWinner = { important: boolean; value: string };

const inlineStyleCache = new WeakMap<Element, Map<string, InlineStyleWinner>>();

const supportedInlineStyleProperties = new Set([
  "-webkit-text-fill-color",
  "all",
  "aspect-ratio",
  "block-size",
  "bottom",
  "clip",
  "clip-path",
  "color",
  "content-visibility",
  "display",
  "filter",
  "font",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "inline-size",
  "inset",
  "left",
  "list-style",
  "list-style-image",
  "list-style-type",
  "mask",
  "mask-image",
  "max-block-size",
  "max-height",
  "max-inline-size",
  "max-width",
  "min-block-size",
  "min-height",
  "min-inline-size",
  "min-width",
  "opacity",
  "position",
  "right",
  "scale",
  "text-align",
  "text-decoration",
  "text-decoration-line",
  "text-indent",
  "text-transform",
  "top",
  "transform",
  "translate",
  // This does not change whether table-cell text is present, and copied tables
  // commonly include it alongside the text-align declaration we do preserve.
  "vertical-align",
  "visibility",
  "white-space",
  "white-space-collapse",
  "width",
]);

function inlineStyleValues(element: Element) {
  const cached = inlineStyleCache.get(element);
  if (cached) return cached;

  const winners = new Map<string, InlineStyleWinner>();
  for (const declaration of splitCssDeclarations(
    clipboardStyleAttribute(element) ?? "",
  )) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = decodeCssEscapes(
      declaration.slice(0, separator).trim(),
    ).toLowerCase();
    if (!property) continue;
    const rawValue = decodeCssEscapes(declaration.slice(separator + 1).trim());
    const important = /!\s*important\s*$/i.test(rawValue);
    const value = rawValue
      .replace(/\s*!\s*important\s*$/i, "")
      .trim()
      .toLowerCase();
    if (!value) continue;
    const winner = winners.get(property);
    if (!winner || important || !winner.important) {
      winners.set(property, { important, value });
    }
  }
  inlineStyleCache.set(element, winners);
  return winners;
}

function inlineStyleValue(element: Element, targetProperty: string) {
  return inlineStyleValues(element).get(targetProperty)?.value || null;
}

function isVisibilityHidden(element: Element) {
  const visibility = inlineStyleValue(element, "visibility");
  return visibility === "hidden" || visibility === "collapse";
}

function isZeroCssValue(value: string | null) {
  return Boolean(
    value &&
      /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:px|%)?$/i.test(value.trim()),
  );
}

function isZeroSizedImage(element: Element) {
  if (element.tagName.toLowerCase() !== "img") return false;
  const hasConflictingMinimum = ["min-height", "min-width"].some(
    (property) => {
      const value = inlineStyleValue(element, property);
      return Boolean(
        value &&
          !isZeroCssValue(value) &&
          !["auto", "initial", "unset"].includes(value),
      );
    },
  );
  if (hasConflictingMinimum) return false;

  for (const dimension of ["height", "width"]) {
    const styled = inlineStyleValue(element, dimension);
    if (styled) {
      if (isZeroCssValue(styled)) return true;
      continue;
    }
    if (
      /^\+?0+(?:\.0*)?$/.test(
        element.getAttribute(dimension)?.trim() ?? "",
      )
    ) {
      return true;
    }
  }
  return ["max-height", "max-width"].some((property) =>
    isZeroCssValue(inlineStyleValue(element, property)),
  );
}

function serializedImageWidth(element: Element): string | "unsupported" | null {
  const styledWidth = inlineStyleValue(element, "width");
  if (styledWidth) {
    if (["auto", "initial", "unset"].includes(styledWidth)) return null;
    if (!/^\d+(?:\.\d+)?(?:px|%)$/.test(styledWidth)) return "unsupported";
    return normalizeMarkdownImageWidth(styledWidth) ?? "unsupported";
  }
  const attributeWidth = element.getAttribute("width")?.trim();
  if (!attributeWidth) return null;
  if (!/^\d+(?:\.\d+)?$/.test(attributeWidth)) return "unsupported";
  return normalizeMarkdownImageWidth(attributeWidth) ?? "unsupported";
}

function hasUnsupportedImageSizing(root: Element) {
  return Array.from(root.querySelectorAll("img")).some((image) => {
    if (hasOmittedClipboardAncestor(image, root)) return false;
    if (serializedImageWidth(image) === "unsupported") return true;

    const aspectRatio = inlineStyleValue(image, "aspect-ratio");
    if (
      aspectRatio &&
      !["auto", "initial", "unset"].includes(aspectRatio)
    ) {
      return true;
    }

    const height = inlineStyleValue(image, "height");
    if (height && !["auto", "initial", "unset"].includes(height)) return true;
    const heightAttribute = image.getAttribute("height")?.trim();
    if (heightAttribute && !isZeroCssValue(heightAttribute)) return true;

    return [
      "block-size",
      "inline-size",
      "max-block-size",
      "max-height",
      "max-inline-size",
      "max-width",
      "min-block-size",
      "min-height",
      "min-inline-size",
      "min-width",
    ].some((property) => {
      const value = inlineStyleValue(image, property);
      return Boolean(
        value && !["auto", "initial", "none", "unset"].includes(value),
      );
    });
  });
}

function isOmittedClipboardElement(element: Element) {
  const tag = element.tagName.toLowerCase();
  const opacity = inlineStyleValue(element, "opacity");
  return (
    [
      "datalist",
      "desc",
      "audio",
      "canvas",
      "embed",
      "iframe",
      "meter",
      "noembed",
      "noframes",
      "noscript",
      "object",
      "progress",
      "script",
      "style",
      "template",
      "title",
      "video",
    ].includes(tag) ||
    (tag === "input" && element.getAttribute("type")?.toLowerCase() === "hidden") ||
    element.hasAttribute("hidden") ||
    inlineStyleValue(element, "display") === "none" ||
    isVisibilityHidden(element) ||
    inlineStyleValue(element, "content-visibility") === "hidden" ||
    (opacity !== null && Number.parseFloat(opacity) <= 0) ||
    isZeroSizedImage(element)
  );
}

function hasOmittedClipboardAncestor(element: Element, boundary: Element) {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (isOmittedClipboardElement(current)) return true;
    if (current === boundary) return false;
  }
  return false;
}

function hasVisibleDescendantOfHiddenElement(root: Element) {
  let inheritedVisibilityHidden = false;
  for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const visibility = inlineStyleValue(ancestor, "visibility");
    if (visibility === "visible" || visibility === "initial") {
      inheritedVisibilityHidden = false;
    } else if (visibility === "hidden" || visibility === "collapse") {
      inheritedVisibilityHidden = true;
    }
  }
  const pending: Array<{ element: Element; hiddenByVisibility: boolean }> = [
    { element: root, hiddenByVisibility: inheritedVisibilityHidden },
  ];
  while (pending.length > 0) {
    const { element, hiddenByVisibility } = pending.pop()!;
    const ownVisibility = inlineStyleValue(element, "visibility");
    const resetsHiddenVisibility =
      ownVisibility === "visible" || ownVisibility === "initial";
    if (
      hiddenByVisibility &&
      ownVisibility &&
      !["collapse", "hidden", "inherit", "unset"].includes(ownVisibility)
    ) {
      return true;
    }
    const childHiddenByVisibility = resetsHiddenVisibility
      ? false
      : isVisibilityHidden(element) || hiddenByVisibility;
    for (const child of element.children) {
      pending.push({ element: child, hiddenByVisibility: childHiddenByVisibility });
    }
  }
  return false;
}

function exceedsClipboardComplexity(root: Node) {
  const pending: Array<{ depth: number; node: Node }> = [{ depth: 0, node: root }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const { depth, node } = pending.pop()!;
    nodeCount += 1;
    if (depth > MAX_PASTED_DOM_DEPTH || nodeCount > MAX_PASTED_DOM_NODES) {
      return true;
    }
    for (const child of node.childNodes) {
      pending.push({ depth: depth + 1, node: child });
    }
    if (
      node instanceof HTMLTemplateElement &&
      node.content.childNodes.length > 0
    ) {
      for (const child of node.content.childNodes) {
        pending.push({ depth: depth + 1, node: child });
      }
    }
  }
  return false;
}

function hasUnresolvedStylesheet(document: Document) {
  if (document.querySelector("style")) return true;
  return Array.from(document.querySelectorAll("link[rel]")).some((link) =>
    (link.getAttribute("rel") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .includes("stylesheet"),
  );
}

function hasUnsupportedAllStyle(root: Element) {
  return elementsWithClipboardStyle(root).some(
    (element) => inlineStyleValue(element, "all") !== null,
  );
}

function hasUnsupportedInlineStyleProperty(root: Element) {
  return elementsWithClipboardStyle(root).some((element) => {
    if (hasOmittedClipboardAncestor(element, root)) return false;
    return Array.from(inlineStyleValues(element).keys()).some(
      (property) =>
        !property.startsWith("--") &&
        !supportedInlineStyleProperties.has(property),
    );
  });
}

function hasUnsupportedInlineFormattingStyle(root: Element) {
  const formattingProperties = [
    "font-style",
    "font-weight",
    "text-decoration",
    "text-decoration-line",
  ];
  return elementsWithClipboardStyle(root).some(
    (element) => {
      if (hasOmittedClipboardAncestor(element, root)) return false;
      const textTransform = inlineStyleValue(element, "text-transform");
      return (
        formattingProperties.some(
          (property) => inlineStyleValue(element, property) !== null,
        ) ||
        Boolean(
          textTransform && !["initial", "none"].includes(textTransform),
        )
      );
    },
  );
}

const blockDisplayTags = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "summary",
  "ul",
]);

const tableDisplayByTag = new Map([
  ["caption", "table-caption"],
  ["col", "table-column"],
  ["colgroup", "table-column-group"],
  ["table", "table"],
  ["tbody", "table-row-group"],
  ["td", "table-cell"],
  ["tfoot", "table-footer-group"],
  ["th", "table-cell"],
  ["thead", "table-header-group"],
  ["tr", "table-row"],
]);

function expectedDisplay(element: Element) {
  const tag = element.tagName.toLowerCase();
  if (tag === "li") return "list-item";
  return tableDisplayByTag.get(tag) ?? (blockDisplayTags.has(tag) ? "block" : "inline");
}

function hasUnsupportedDisplay(element: Element, display: string | null) {
  if (!display || display === "none") return false;
  const normalized = display === "initial" || display === "unset"
    ? "inline"
    : display;
  return normalized !== expectedDisplay(element);
}

function isNonOpaqueCssColor(value: string | null) {
  if (!value) return false;
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (
    compact === "transparent" ||
    /^(?:color-mix|env|light-dark|var)\(/.test(compact)
  ) {
    return true;
  }
  const shortHex = /^#[\da-f]{4}$/.exec(compact);
  if (shortHex) return compact.at(-1) !== "f";
  const longHex = /^#[\da-f]{8}$/.exec(compact);
  if (longHex) return !compact.endsWith("ff");
  const functional = /^(color|hsla?|hwb|lab|lch|oklab|oklch|rgba?)\((.*)\)$/.exec(
    compact,
  );
  if (!functional) return false;
  const [, name, argumentsText] = functional;
  const slash = argumentsText.lastIndexOf("/");
  const comma = argumentsText.lastIndexOf(",");
  const alphaSeparator = slash >= 0
    ? slash
    : /^(?:rgba|hsla)$/.test(name) && comma >= 0
      ? comma
      : -1;
  if (alphaSeparator < 0) return false;
  const alpha = argumentsText.slice(alphaSeparator + 1);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(alpha)) return true;
  const numericAlpha = Number.parseFloat(alpha);
  return alpha.endsWith("%") ? numericAlpha < 100 : numericAlpha < 1;
}

function parsedCssOpacity(value: string) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value)) return null;
  const numeric = Number.parseFloat(value);
  return value.endsWith("%") ? numeric / 100 : numeric;
}

function hasUnsafeVerticalAlign(value: string | null) {
  if (!value || isZeroCssValue(value)) return false;
  if (
    [
      "baseline",
      "bottom",
      "inherit",
      "initial",
      "middle",
      "revert",
      "revert-layer",
      "sub",
      "super",
      "text-bottom",
      "text-top",
      "top",
      "unset",
    ].includes(value)
  ) {
    return false;
  }
  // Unknown identifiers are invalid and ignored by the browser. Lengths,
  // percentages, and functions can move inline content outside its line box.
  return !/^-?[a-z]+(?:-[a-z]+)*$/.test(value);
}

function hasUnsupportedBoxLayout(element: Element) {
  if (element.tagName.toLowerCase() !== "img") {
    for (const property of [
      "block-size",
      "height",
      "inline-size",
      "max-block-size",
      "max-height",
      "max-inline-size",
      "max-width",
      "min-block-size",
      "min-height",
      "min-inline-size",
      "min-width",
      "width",
    ]) {
      const value = inlineStyleValue(element, property);
      if (
        value &&
        !["auto", "initial", "none", "unset"].includes(value)
      ) {
        return true;
      }
    }
  }
  const position = inlineStyleValue(element, "position");
  if (position && !["initial", "static", "unset"].includes(position)) {
    return true;
  }
  for (const property of ["bottom", "inset", "left", "right", "top"]) {
    const value = inlineStyleValue(element, property);
    if (value && !["auto", "initial", "unset"].includes(value)) return true;
  }
  const textIndent = inlineStyleValue(element, "text-indent");
  return Boolean(
    textIndent &&
      !isZeroCssValue(textIndent) &&
      !["initial", "unset"].includes(textIndent),
  );
}

function hasUnsupportedVisibilityStyle(root: Element) {
  return elementsWithClipboardStyle(root).some(
    (element) => {
      const visibility = inlineStyleValue(element, "visibility");
      if (
        visibility &&
        !["collapse", "hidden", "inherit", "initial", "unset", "visible"].includes(
          visibility,
        )
      ) {
        return true;
      }
      const contentVisibility = inlineStyleValue(element, "content-visibility");
      if (
        contentVisibility &&
        !["hidden", "inherit", "initial", "unset", "visible"].includes(
          contentVisibility,
        )
      ) {
        return true;
      }
      const opacity = inlineStyleValue(element, "opacity");
      if (opacity && !["inherit", "initial", "unset"].includes(opacity)) {
        const parsedOpacity = parsedCssOpacity(opacity);
        if (
          parsedOpacity === null ||
          (parsedOpacity > 0 && parsedOpacity < 1)
        ) {
          return true;
        }
      }
      const display = inlineStyleValue(element, "display");
      if (hasUnsupportedDisplay(element, display)) return true;
      if (hasUnsafeVerticalAlign(inlineStyleValue(element, "vertical-align"))) {
        return true;
      }
      if (hasUnsupportedBoxLayout(element)) return true;
      const nonDefaultVisualProperties = [
        ["clip", "auto"],
        ["clip-path", "none"],
        ["filter", "none"],
        ["mask", "none"],
        ["mask-image", "none"],
        ["scale", "none"],
        ["transform", "none"],
        ["translate", "none"],
      ] as const;
      if (
        nonDefaultVisualProperties.some(([property, defaultValue]) => {
          const value = inlineStyleValue(element, property);
          return Boolean(
            value &&
              ![defaultValue, "inherit", "initial", "unset"].includes(value),
          );
        })
      ) {
        return true;
      }
      if (inlineStyleValue(element, "font") !== null) return true;
      const fontSize = inlineStyleValue(element, "font-size");
      if (
        fontSize &&
        !["inherit", "initial", "medium", "unset"].includes(fontSize)
      ) {
        return true;
      }
      return (
        isNonOpaqueCssColor(inlineStyleValue(element, "color")) ||
        isNonOpaqueCssColor(
          inlineStyleValue(element, "-webkit-text-fill-color"),
        )
      );
    },
  );
}

function hasUnsupportedResponsiveImage(root: Element) {
  return Array.from(root.querySelectorAll("picture, img")).some(
    (element) =>
      !hasOmittedClipboardAncestor(element, root) &&
      (element.tagName.toLowerCase() === "picture" ||
        Boolean(clipboardResourceAttribute(element, "srcset")?.trim())),
  );
}

function destinationNeedsBase(value: string, media: boolean) {
  const destination = value.trim();
  if (!destination) return !media;
  if (/^https?:/i.test(destination) && !/^https?:\/\//i.test(destination)) {
    return true;
  }
  return !/^[a-z][a-z\d+.-]*:/i.test(destination) &&
    !destination.startsWith("//") &&
    !destination.startsWith("#");
}

function destinationElements(document: Document) {
  return [
    ...Array.from(document.body.querySelectorAll("a[href]")),
    ...Array.from(document.body.querySelectorAll("img")).filter(
      (image) => clipboardResourceAttribute(image, "src") !== null,
    ),
  ];
}

function resolveBaseRelativeDestinations(document: Document) {
  const base = Array.from(document.querySelectorAll("base[href]")).find(
    (element) => element.namespaceURI === "http://www.w3.org/1999/xhtml",
  );
  if (!base) {
    return !destinationElements(document).some(
      (element) => {
        if (hasOmittedClipboardAncestor(element, document.body)) return false;
        const attribute = element.tagName.toLowerCase() === "a" ? "href" : "src";
        return destinationNeedsBase(
          attribute === "src"
            ? clipboardResourceAttribute(element, attribute) ?? ""
            : element.getAttribute(attribute) ?? "",
          attribute === "src",
        );
      },
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(base.getAttribute("href")?.trim() ?? "");
  } catch {
    return false;
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    return false;
  }

  for (const element of destinationElements(document)) {
    if (hasOmittedClipboardAncestor(element, document.body)) continue;
    const attribute = element.tagName.toLowerCase() === "a" ? "href" : "src";
    const rawValue = attribute === "src"
      ? clipboardResourceAttribute(element, attribute)
      : element.getAttribute(attribute);
    if (rawValue === null) continue;
    const value = rawValue.trim();
    if (!value && attribute === "src") continue;
    try {
      const resolved = new URL(value, baseUrl).href;
      if (attribute === "src") {
        setClipboardResourceAttribute(element, attribute, resolved);
      } else {
        element.setAttribute(attribute, resolved);
      }
    } catch {
      return false;
    }
  }
  return true;
}

function hasUnsupportedInteractiveVisibility(root: Element) {
  return Array.from(
    root.querySelectorAll("details:not([open]), dialog:not([open]), [popover]"),
  ).some((element) => !hasOmittedClipboardAncestor(element, root));
}

function hasUnsupportedWhitespaceStyle(root: Element) {
  const isUnsupported = (element: Element) => {
    if (hasOmittedClipboardAncestor(element, root)) return false;
    const whiteSpace = inlineStyleValue(element, "white-space");
    const whiteSpaceCollapse = inlineStyleValue(
      element,
      "white-space-collapse",
    );
    const pre = element.closest("pre");
    if (
      (whiteSpace !== null || whiteSpaceCollapse !== null) &&
      pre &&
      root.contains(pre)
    ) {
      return true;
    }
    return (
      Boolean(
        whiteSpace &&
          !["inherit", "normal", "nowrap", "unset"].includes(whiteSpace),
      ) ||
      Boolean(
        whiteSpaceCollapse &&
          !["collapse", "inherit", "initial", "unset"].includes(
            whiteSpaceCollapse,
          ),
      )
    );
  };

  if (
    (root.hasAttribute(CLIPBOARD_STYLE_ATTRIBUTE) && isUnsupported(root)) ||
    Array.from(
      root.querySelectorAll(`[${CLIPBOARD_STYLE_ATTRIBUTE}]`),
    ).some(isUnsupported)
  ) {
    return true;
  }
  for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const whiteSpace = inlineStyleValue(ancestor, "white-space");
    const whiteSpaceCollapse = inlineStyleValue(
      ancestor,
      "white-space-collapse",
    );
    if (
      (whiteSpace &&
        !["inherit", "normal", "nowrap", "unset"].includes(whiteSpace)) ||
      (whiteSpaceCollapse &&
        !["collapse", "inherit", "initial", "unset"].includes(
          whiteSpaceCollapse,
        ))
    ) {
      return true;
    }
  }
  return false;
}

function markdownCode(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/\n/g, " ");
  if (!normalized) return "";
  const longestRun = longestBacktickRun(normalized);
  const marker = "`".repeat(longestRun + 1);
  const padding = !/^[ \t]+$/.test(normalized) && /^`|`$|^ | $/.test(normalized)
    ? " "
    : "";
  return `${marker}${padding}${normalized}${padding}${marker}`;
}

function longestBacktickRun(value: string) {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

function filteredCodeText(element: Element): string {
  return Array.from(element.childNodes)
    .map((child) => {
      if (child.nodeType === Node.TEXT_NODE) return child.textContent ?? "";
      if (!(child instanceof Element) || isOmittedClipboardElement(child)) return "";
      if (child.tagName.toLowerCase() === "br") return "\n";
      return filteredCodeText(child);
    })
    .join("");
}

function inlineFormattingKind(element: Element): InlineFormattingKind | null {
  const tag = element.tagName.toLowerCase();
  if (tag === "strong" || tag === "b") return "strong";
  if (tag === "em" || tag === "i") return "emphasis";
  if (tag === "del" || tag === "s" || tag === "strike") return "delete";
  if (tag === "code" && element.parentElement?.tagName.toLowerCase() !== "pre") {
    return "code";
  }
  return null;
}

function nextInlineBoundaryPreview(
  nodes: Node[],
  start: number,
  context: InlineContext,
  cache: Map<number, string | null>,
) {
  if (cache.has(start)) return cache.get(start) ?? null;
  for (let index = start; index < nodes.length; index += 1) {
    const node = nodes[index];
    const kind = node instanceof Element ? inlineFormattingKind(node) : null;
    if (kind !== null) {
      const run: Node[] = [node];
      let cursor = index + 1;
      while (cursor < nodes.length) {
        const candidate = nodes[cursor];
        if (
          candidate instanceof Element &&
          inlineFormattingKind(candidate) === kind
        ) {
          run.push(candidate);
        } else if (serializeInline(candidate, context) !== "") {
          break;
        }
        cursor += 1;
      }
      const after =
        nextInlineBoundaryPreview(nodes, cursor, context, cache) ??
        context.boundaryAfter ??
        "";
      const value = serializeInlineNodes(run, {
        ...context,
        boundaryAfter: after,
      });
      if (value) {
        const preview = value[0] ?? null;
        cache.set(start, preview);
        return preview;
      }
      index = cursor - 1;
      continue;
    }
    const value = serializeInline(node, context);
    if (value) {
      const preview = value[0] ?? null;
      cache.set(start, preview);
      return preview;
    }
  }
  cache.set(start, null);
  return null;
}

function inlineFormattingMarker(
  kind: Exclude<InlineFormattingKind, "code">,
  context: InlineContext,
) {
  if (kind === "strong") return "**";
  if (kind === "delete") return "~~";
  return context.emphasisMarker ?? "*";
}

function hasOnlyEmphasisContent(nodes: Node[], context: InlineContext) {
  const flattened = flattenTransparentInlineNodes(nodes, context);
  return (
    flattened.length > 0 &&
    flattened.every(
      (node) =>
        (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) ||
        (node instanceof Element &&
          inlineFormattingKind(node) === "emphasis"),
    )
  );
}

function precedingInlineBoundary(pieces: string[], marker: string) {
  const delimiter = marker[0];
  for (let pieceIndex = pieces.length - 1; pieceIndex >= 0; pieceIndex -= 1) {
    const piece = pieces[pieceIndex];
    for (let index = piece.length - 1; index >= 0; index -= 1) {
      if (piece[index] !== delimiter) return piece[index];
    }
  }
  return null;
}

function flattenTransparentInlineNodes(nodes: Node[], context: InlineContext) {
  const flattened: Node[] = [];
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node instanceof Element) {
      if (isOmittedClipboardElement(node)) continue;
      const tag = node.tagName.toLowerCase();
      const formattingKind = inlineFormattingKind(node);
      if (
        formattingKind !== null &&
        context.activeFormatting?.has(formattingKind)
      ) {
        for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
          pending.push(node.childNodes[index]);
        }
        continue;
      }
      const handled =
        formattingKind !== null ||
        tag === "a" ||
        tag === "br" ||
        tag === "img" ||
        (tag === "input" && node.getAttribute("type")?.toLowerCase() === "checkbox") ||
        (context.tableCell && tableCellBlockTagPattern.test(tag));
      if (!handled) {
        for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
          pending.push(node.childNodes[index]);
        }
        continue;
      }
    }
    flattened.push(node);
  }
  return flattened;
}

function serializeInlineNodes(nodes: Node[], context: InlineContext = {}) {
  const pieces: string[] = [];
  const inlineNodes = flattenTransparentInlineNodes(nodes, context);
  const boundaryPreviewCache = new Map<number, string | null>();
  let index = 0;

  while (index < inlineNodes.length) {
    const node = inlineNodes[index];
    if (node.nodeType === Node.TEXT_NODE) {
      let text = "";
      let cursor = index;
      while (cursor < inlineNodes.length) {
        const candidate = inlineNodes[cursor];
        if (candidate.nodeType === Node.TEXT_NODE) {
          text += candidate.textContent ?? "";
        } else if (serializeInline(candidate, context) !== "") {
          break;
        }
        cursor += 1;
      }
      const value = escapeInlineText(text, context);
      appendInlinePiece(pieces, value);
      index = cursor;
      continue;
    }
    const element = node instanceof Element ? node : null;
    const kind = element && !isOmittedClipboardElement(element)
      ? inlineFormattingKind(element)
      : null;
    if (!kind) {
      const value = serializeInline(node, context);
      appendInlinePiece(pieces, value);
      index += 1;
      continue;
    }

    const run: Element[] = [element!];
    let cursor = index + 1;
    while (cursor < inlineNodes.length) {
      const candidate = inlineNodes[cursor];
      if (
        candidate instanceof Element &&
        !isOmittedClipboardElement(candidate) &&
        inlineFormattingKind(candidate) === kind
      ) {
        run.push(candidate);
      } else if (serializeInline(candidate, context) !== "") {
        break;
      }
      cursor += 1;
    }

    if (kind === "code") {
      const value = run.map(filteredCodeText).join("");
      appendInlinePiece(
        pieces,
        markdownCode(
          context.tableCell
            ? value.replace(/(\\*)\|/g, "$1\\|")
            : value,
        ),
      );
    } else {
      const after =
        nextInlineBoundaryPreview(
          inlineNodes,
          cursor,
          context,
          boundaryPreviewCache,
        ) ??
        context.boundaryAfter ??
        "";
      const activeFormatting = new Set(context.activeFormatting);
      activeFormatting.add(kind);
      const childNodes = run.flatMap((element) => Array.from(element.childNodes));
      let marker = inlineFormattingMarker(kind, context);
      let before =
        precedingInlineBoundary(pieces, marker) ?? context.boundaryBefore ?? "";
      const serializeContent = () =>
        serializeInlineNodes(childNodes, {
          ...context,
          activeFormatting,
          boundaryAfter: after,
          boundaryBefore: before,
          emphasisMarker:
            kind === "strong"
              ? marker === "__"
                ? "*"
                : hasOnlyEmphasisContent(childNodes, context)
                  ? "_"
                  : context.emphasisMarker
              : context.emphasisMarker,
        });
      let content = serializeContent();
      const contentBoundary = splitInlineBoundaries(content);
      if (
        kind === "strong" &&
        marker === "**" &&
        ((after === "*" &&
          !contentBoundary.trailing &&
          isMarkdownPunctuation(contentBoundary.value.at(-1) ?? "")) ||
          pieces.at(-1)?.endsWith("*"))
      ) {
        marker = "__";
        before =
          precedingInlineBoundary(pieces, marker) ??
          context.boundaryBefore ??
          "";
        content = serializeContent();
      }
      appendInlinePiece(
        pieces,
        context.activeFormatting?.has(kind)
          ? content
          : wrapInline(content, marker, before, after),
      );
    }
    index = cursor;
  }

  return pieces.join("");
}

function serializeInlineChildren(element: Element, context: InlineContext = {}) {
  return serializeInlineNodes(Array.from(element.childNodes), context);
}

function serializeInline(node: Node, context: InlineContext = {}): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeInlineText(node.textContent ?? "", context);
  }
  if (!(node instanceof Element)) {
    return "";
  }
  if (isOmittedClipboardElement(node)) {
    return "";
  }

  const tag = node.tagName.toLowerCase();
  if (tag === "br") {
    return context.tableCell || context.flattenBreaks ? " " : "\n";
  }
  if (
    context.tableCell && tableCellBlockTagPattern.test(tag)
  ) {
    const content = trimSerializedMarkdown(serializeInlineChildren(node, context));
    return content ? `${content} ` : "";
  }
  if (tag === "strong" || tag === "b") {
    return wrapInline(
      serializeInlineChildren(node, context),
      inlineFormattingMarker("strong", context),
    );
  }
  if (tag === "em" || tag === "i") {
    return wrapInline(
      serializeInlineChildren(node, context),
      inlineFormattingMarker("emphasis", context),
    );
  }
  if (tag === "del" || tag === "s" || tag === "strike") {
    return wrapInline(
      serializeInlineChildren(node, context),
      inlineFormattingMarker("delete", context),
    );
  }
  if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") {
    const value = filteredCodeText(node);
    return markdownCode(
      context.tableCell
        ? value.replace(/(\\*)\|/g, "$1\\|")
        : value,
    );
  }
  if (tag === "a") {
    const content = serializeInlineChildren(node, context);
    const { leading, trailing, value: label } = splitInlineBoundaries(content);
    const href = node.getAttribute("href")?.trim();
    const rawTitle = node.getAttribute("title");
    const title = rawTitle ? markdownLinkTitle(rawTitle, context) : null;
    return href && label && isSafeMarkdownDestination(href, false)
      ? `${leading}[${label}](${markdownLinkDestination(href)}${title ? ` \"${title}\"` : ""})${trailing}`
      : content;
  }
  if (tag === "img") {
    const alt = escapeInlineText(node.getAttribute("alt") ?? "", context);
    const src = clipboardResourceAttribute(node, "src")?.trim();
    if (!src || !isSafeMarkdownDestination(src, true)) return alt;
    const rawTitle = node.getAttribute("title");
    const title = rawTitle ? markdownLinkTitle(rawTitle, context) : null;
    const width = serializedImageWidth(node);
    const widthMetadata = width && width !== "unsupported"
      ? `{width=${width}}`
      : "";
    return `![${alt}](${markdownLinkDestination(src)}${title ? ` \"${title}\"` : ""})${widthMetadata}`;
  }
  if (tag === "input" && node.getAttribute("type")?.toLowerCase() === "checkbox") {
    return node.hasAttribute("checked") ? "[x]" : "[ ]";
  }

  return serializeInlineChildren(node, context);
}

function directChildren(element: Element, tagName: string) {
  return Array.from(element.children).filter(
    (child) => child.tagName.toLowerCase() === tagName,
  );
}

function orderedListStart(list: Element) {
  const value = list.getAttribute("start")?.trim();
  if (!value || !/^[+-]?\d+$/.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasUnsupportedListStyle(
  element: Element,
  supportedTypes: ReadonlySet<string>,
) {
  let resolvedImage = false;
  let resolvedType = false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const shorthand = inlineStyleValue(current, "list-style");
    if (shorthand && shorthand !== "inherit" && shorthand !== "unset") {
      return true;
    }
    if (!resolvedType) {
      const type = inlineStyleValue(current, "list-style-type");
      if (type && type !== "inherit" && type !== "unset") {
        if (!supportedTypes.has(type)) return true;
        resolvedType = true;
      }
    }
    if (!resolvedImage) {
      const image = inlineStyleValue(current, "list-style-image");
      if (image && image !== "inherit" && image !== "unset") {
        if (image !== "none") return true;
        resolvedImage = true;
      }
    }
    if (resolvedImage && resolvedType) return false;
  }
  return false;
}

function serializeList(list: Element, indent = ""): string {
  const ordered = list.tagName.toLowerCase() === "ol";
  const start = ordered ? orderedListStart(list) : 1;
  if (start === null) return "";
  return directChildren(list, "li")
    .filter((item) => !isOmittedClipboardElement(item))
    .map((item, index) => {
      const marker = ordered ? `${start + index}.` : "-";
      const hasLeadingTaskCheckbox = directChildren(item, "input").some(
        isSupportedTaskCheckbox,
      );
      const continuationIndent = `${indent}${" ".repeat(marker.length + 1)}`;
      const segments: Array<{ kind: "content" | "list"; value: string }> = [];
      let contentNodes: Node[] = [];
      const flushContent = () => {
        if (contentNodes.length === 0) return;
        const wrapper = item.cloneNode(false) as Element;
        for (const node of contentNodes) wrapper.append(node.cloneNode(true));
        const value = trimSerializedMarkdown(serializeBlocks(wrapper));
        if (value) segments.push({ kind: "content", value });
        contentNodes = [];
      };

      for (const node of item.childNodes) {
        if (
          node instanceof Element &&
          ["menu", "ol", "ul"].includes(node.tagName.toLowerCase())
        ) {
          if (isOmittedClipboardElement(node)) continue;
          flushContent();
          const value = serializeList(node, continuationIndent);
          if (value) segments.push({ kind: "list", value });
        } else {
          contentNodes.push(node);
        }
      }
      flushContent();

      let result = `${indent}${marker}`;
      let hasSegment = false;
      let previousKind: "content" | "list" | null = null;
      for (const segment of segments) {
        const segmentValue =
          hasLeadingTaskCheckbox && !hasSegment && segment.kind === "content"
          ? segment.value.replace(/^\[([ x])\][ \t]*/i, "[$1] ")
          : segment.value;
        if (segment.kind === "list") {
          result += `${previousKind === "list" ? "\n\n" : "\n"}${segmentValue}`;
        } else if (!hasSegment) {
          const [firstLine, ...remainingLines] = segmentValue.split("\n");
          result += ` ${firstLine}`;
          if (remainingLines.length > 0) {
            result += `\n${remainingLines
              .map((line) => (line ? `${continuationIndent}${line}` : ""))
              .join("\n")}`;
          }
        } else {
          result += `\n\n${segmentValue
            .split("\n")
            .map((line) => (line ? `${continuationIndent}${line}` : ""))
            .join("\n")}`;
        }
        hasSegment = true;
        previousKind = segment.kind;
      }
      return trimSerializedMarkdownEnd(result);
    })
    .join("\n");
}

function isSupportedTaskCheckbox(control: Element) {
  if (
    control.tagName.toLowerCase() !== "input" ||
    control.getAttribute("type")?.toLowerCase() !== "checkbox"
  ) {
    return false;
  }
  const item = control.parentElement;
  const list = item?.parentElement;
  if (
    item?.tagName.toLowerCase() !== "li" ||
    !list ||
    !["menu", "ol", "ul"].includes(list.tagName.toLowerCase())
  ) {
    return false;
  }
  const visibleCheckboxes = directChildren(item, "input").filter(
    (candidate) =>
      candidate.getAttribute("type")?.toLowerCase() === "checkbox" &&
      !isOmittedClipboardElement(candidate),
  );
  if (visibleCheckboxes.length !== 1) return false;
  for (let sibling = control.previousSibling; sibling; sibling = sibling.previousSibling) {
    if (sibling.nodeType === Node.TEXT_NODE) {
      if (sibling.textContent?.trim()) return false;
    } else if (sibling instanceof Element && !isOmittedClipboardElement(sibling)) {
      return false;
    }
  }
  return true;
}

type TableAlignment = "center" | "left" | "right";

const legacyTextAlignTags = new Set([
  "caption",
  "col",
  "colgroup",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
]);

function isTableAlignment(value: string | null): value is TableAlignment {
  return value === "left" || value === "center" || value === "right";
}

function tableCellAlignment(cell: Element): TableAlignment | "unsupported" | null {
  const ownAlignment = inlineStyleValue(cell, "text-align");
  if (isTableAlignment(ownAlignment)) {
    return ownAlignment;
  }
  if (!ownAlignment) {
    const attribute = cell.getAttribute("align")?.toLowerCase() ?? null;
    if (isTableAlignment(attribute)) return attribute;
    if (attribute) return "unsupported";
  } else if (ownAlignment !== "inherit" && ownAlignment !== "unset") {
    return "unsupported";
  }
  const table = cell.closest("table");
  for (let ancestor = cell.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const alignment = inlineStyleValue(ancestor, "text-align");
    if (isTableAlignment(alignment)) return alignment;
    if (alignment && alignment !== "inherit" && alignment !== "unset") {
      return "unsupported";
    }
    if (
      !alignment &&
      ancestor !== table &&
      legacyTextAlignTags.has(ancestor.tagName.toLowerCase())
    ) {
      const attribute = ancestor.getAttribute("align")?.toLowerCase() ?? null;
      if (isTableAlignment(attribute)) return attribute;
      if (attribute) return "unsupported";
    }
  }
  return null;
}

function looksNumeric(value: string) {
  const plain = value
    .replace(/[*_~`]/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .trim();
  return /^(?:[$€£¥]\s*)?[+-]?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?(?:\s*(?:%|[KMBT]))?$/.test(
    plain,
  );
}

function hasOddBackslashPipeRun(value: string) {
  for (const match of value.matchAll(/\\+\|/g)) {
    if ((match[0].length - 1) % 2 === 1) return true;
  }
  return false;
}

function hasUnrepresentableTableCodeRun(container: Element) {
  const pending = [container];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const nodes = flattenTransparentInlineNodes(Array.from(current.childNodes), {
      tableCell: true,
    });
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      const kind = inlineFormattingKind(node);
      const tag = node.tagName.toLowerCase();
      if (
        kind !== "code" &&
        (kind !== null || tag === "a" || tableCellBlockTagPattern.test(tag))
      ) {
        pending.push(node);
      }
    }

    let index = 0;
    while (index < nodes.length) {
      const node = nodes[index];
      if (!(node instanceof Element) || inlineFormattingKind(node) !== "code") {
        index += 1;
        continue;
      }
      let value = "";
      while (index < nodes.length) {
        const candidate = nodes[index];
        if (
          candidate instanceof Element &&
          inlineFormattingKind(candidate) === "code"
        ) {
          value += filteredCodeText(candidate);
          index += 1;
          continue;
        }
        if (serializeInline(candidate, { tableCell: true }) === "") {
          index += 1;
          continue;
        }
        break;
      }
      if (hasOddBackslashPipeRun(value)) return true;
    }
  }
  return false;
}

function tableRowsInVisualOrder(table: Element) {
  return Array.from(table.querySelectorAll("tr"))
    .filter(
      (row) =>
        row.closest("table") === table &&
        !hasOmittedClipboardAncestor(row, table),
    )
    .map((row, index) => {
      const section = row.closest("thead, tbody, tfoot");
      const sectionTag = section?.closest("table") === table
        ? section.tagName.toLowerCase()
        : "tbody";
      const rank = sectionTag === "thead" ? 0 : sectionTag === "tfoot" ? 2 : 1;
      return { index, rank, row };
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ row }) => row);
}

function serializeTable(table: Element) {
  const caption = directChildren(table, "caption").find(
    (candidate) => !isOmittedClipboardElement(candidate),
  );
  const captionMarkdown = caption
    ? trimSerializedMarkdown(serializeBlocks(caption))
    : "";
  const rowElements = tableRowsInVisualOrder(table);
  const serializedRows = rowElements.map((row) => {
    const values: string[] = [];
    const alignments: ReturnType<typeof tableCellAlignment>[] = [];
    const cells = Array.from(row.children).filter((cell) =>
      ["td", "th"].includes(cell.tagName.toLowerCase()) &&
      !isOmittedClipboardElement(cell),
    );
    for (const cell of cells) {
      const remainingColumns = MAX_PASTED_TABLE_COLUMNS - values.length;
      if (remainingColumns <= 0) break;
      const value = trimSerializedMarkdown(
        serializeInlineChildren(cell, { tableCell: true }),
      ).replace(/[\t\f\r ]*\n[\t\n\f\r ]*/g, " ");
      const requestedSpan = Number.parseInt(cell.getAttribute("colspan") ?? "1", 10);
      const span = Math.min(
        remainingColumns,
        Math.max(1, Number.isNaN(requestedSpan) ? 1 : requestedSpan),
      );
      values.push(value, ...Array.from({ length: span - 1 }, () => ""));
      alignments.push(...Array.from({ length: span }, () => tableCellAlignment(cell)));
    }
    return {
      alignments,
      isHeaderRow:
        row.closest("thead")?.closest("table") === table ||
        (cells.length > 0 &&
          cells.every((cell) => cell.tagName.toLowerCase() === "th") &&
          !cells.some(
            (cell) =>
              ["row", "rowgroup"].includes(
                cell.getAttribute("scope")?.toLowerCase() ?? "",
              ),
          )),
      values,
    };
  });
  const rows = serializedRows.map((row) => row.values);
  const columnCount = rows.reduce(
    (largest, row) => Math.max(largest, row.length),
    0,
  );
  if (rows.length === 0 || columnCount === 0) {
    return captionMarkdown;
  }

  const normalizedRows = rows.map((row) => [
    ...row,
    ...Array.from({ length: columnCount - row.length }, () => ""),
  ]);
  const firstRowIsHeader = serializedRows[0]?.isHeaderRow ?? false;
  const headerRow = firstRowIsHeader
    ? normalizedRows[0]
    : Array.from({ length: columnCount }, () => "");
  const bodyRows = firstRowIsHeader ? normalizedRows.slice(1) : normalizedRows;
  const alignments = Array.from({ length: columnCount }, (_, index) => {
    const explicit = serializedRows
      .map((row) => row.alignments[index] ?? null)
      .find((alignment): alignment is TableAlignment => isTableAlignment(alignment));
    if (explicit) return explicit;
    const values = bodyRows.map((row) => row[index]?.trim() ?? "").filter(Boolean);
    return values.length > 0 && values.every(looksNumeric) ? "right" : null;
  });
  const delimiter = alignments.map((alignment) =>
    alignment === "right" ? "---:" : alignment === "center" ? ":---:" : "---",
  );
  const renderRow = (row: string[]) => `| ${row.join(" | ")} |`;
  const markdown = [renderRow(headerRow), renderRow(delimiter), ...bodyRows.map(renderRow)].join(
    "\n",
  );
  return captionMarkdown ? `${captionMarkdown}\n\n${markdown}` : markdown;
}

function tableCellSpan(cell: Element, attribute: "colspan" | "rowspan") {
  const parsed = Number.parseInt(cell.getAttribute(attribute) ?? "1", 10);
  if (attribute === "rowspan" && parsed === 0) return 0;
  return Number.isNaN(parsed) ? 1 : Math.max(1, parsed);
}

function tableHasUnsupportedShape(table: Element) {
  const visibleCaptions = directChildren(table, "caption").filter(
    (caption) => !isOmittedClipboardElement(caption),
  );
  if (visibleCaptions.length > 1) return true;

  const tableStructure = [
    table,
    ...Array.from(
      table.querySelectorAll(
        "caption, col, colgroup, table, tbody, td, tfoot, th, thead, tr",
      ),
    ).filter((element) => element.closest("table") === table),
  ];
  const hasVisibleLegacySizing = tableStructure.some(
    (element) =>
      !hasOmittedClipboardAncestor(element, table) &&
      (element.hasAttribute("height") || element.hasAttribute("width")),
  );
  if (hasVisibleLegacySizing) return true;

  const hasVisibleNestedTable = Array.from(table.querySelectorAll("table")).some(
    (nestedTable) => !hasOmittedClipboardAncestor(nestedTable, table),
  );
  if (hasVisibleNestedTable) return true;
  const hasVisibleUnsupportedBlock = Array.from(
    table.querySelectorAll("hr, pre"),
  ).some(
    (element) =>
      element.closest("table") === table &&
      !hasOmittedClipboardAncestor(element, table),
  );
  if (hasVisibleUnsupportedBlock) return true;

  const hasHiddenStructure = Array.from(
    table.querySelectorAll("col, colgroup, tbody, td, tfoot, th, thead, tr"),
  ).some(
    (element) =>
      element.closest("table") === table &&
      hasOmittedClipboardAncestor(element, table),
  );
  if (hasHiddenStructure) return true;

  const rows = tableRowsInVisualOrder(table);
  const headerRowCount = rows.filter(
    (row) => row.closest("thead")?.closest("table") === table,
  ).length;
  if (headerRowCount > 1) return true;

  const unsupportedCells = rows.some((row) => {
    const cells = Array.from(row.children).filter(
      (cell) =>
        ["td", "th"].includes(cell.tagName.toLowerCase()) &&
        !isOmittedClipboardElement(cell),
    );
    return (
      cells.some((cell) => tableCellSpan(cell, "rowspan") !== 1) ||
      cells.reduce((total, cell) => total + tableCellSpan(cell, "colspan"), 0) >
        MAX_PASTED_TABLE_COLUMNS
    );
  });
  if (unsupportedCells) return true;

  const alignmentsByColumn: Array<Set<string>> = [];
  for (const row of rows) {
    let column = 0;
    const cells = Array.from(row.children).filter(
      (cell) =>
        ["td", "th"].includes(cell.tagName.toLowerCase()) &&
        !isOmittedClipboardElement(cell),
    );
    for (const cell of cells) {
      const span = tableCellSpan(cell, "colspan");
      const alignment = tableCellAlignment(cell);
      if (alignment === "unsupported") return true;
      for (let offset = 0; offset < span; offset += 1) {
        if (alignment) {
          alignmentsByColumn[column + offset] ??= new Set();
          alignmentsByColumn[column + offset].add(alignment);
        }
      }
      column += span;
    }
  }
  if (alignmentsByColumn.some((alignments) => alignments.size > 1)) {
    return true;
  }

  return Array.from(table.querySelectorAll("td, th")).some((cell) => {
    if (
      cell.closest("table") !== table ||
      hasOmittedClipboardAncestor(cell, table)
    ) {
      return false;
    }
    return hasUnrepresentableTableCodeRun(cell);
  });
}

function listHasUnsupportedShape(list: Element) {
  const ordered = list.tagName.toLowerCase() === "ol";
  const hasVisibleNonItemChild = Array.from(list.childNodes).some((node) => {
    if (node.nodeType === Node.TEXT_NODE) return Boolean(node.textContent?.trim());
    if (!(node instanceof Element)) return false;
    return (
      node.tagName.toLowerCase() !== "li" &&
      !isOmittedClipboardElement(node)
    );
  });
  if (hasVisibleNonItemChild) return true;
  const directItems = directChildren(list, "li");
  if (ordered && directItems.some(isOmittedClipboardElement)) return true;
  const items = directItems.filter(
    (item) => !isOmittedClipboardElement(item),
  );
  const supportedTypes = ordered
    ? new Set(["decimal"])
    : new Set(["circle", "disc", "square"]);
  if (items.some((item) => hasUnsupportedListStyle(item, supportedTypes))) {
    return true;
  }
  if (!ordered) return false;

  const start = orderedListStart(list);
  if (start === null) return true;
  const type = list.getAttribute("type");
  return (
    list.hasAttribute("reversed") ||
    (type !== null && type !== "1") ||
    items.some((item) => item.hasAttribute("value")) ||
    items.some((item) => {
      const itemType = item.getAttribute("type");
      return itemType !== null && itemType !== "1";
    }) ||
    start < 0 ||
    start + Math.max(0, items.length - 1) > 999_999_999
  );
}

function hasVisibleOrphanListItem(root: Element) {
  return Array.from(root.querySelectorAll("li")).some((item) => {
    if (hasOmittedClipboardAncestor(item, root)) return false;
    const parentTag = item.parentElement?.tagName.toLowerCase();
    return parentTag !== "menu" && parentTag !== "ol" && parentTag !== "ul";
  });
}

function serializeBlockElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const level = Number.parseInt(tag.slice(1), 10);
    const content = trimSerializedMarkdown(
      serializeInlineChildren(element, { flattenBreaks: true }),
    ).replace(/[ \t]+/g, " ");
    const escapedClosingSequence = content.replace(
      /(^|[ \t])(#+)$/,
      "$1\\$2",
    );
    return `${"#".repeat(level)} ${escapedClosingSequence}`;
  }
  if (tag === "p") {
    return escapeMarkdownBlockStarts(
      trimSerializedMarkdown(serializeInlineChildren(element)),
    );
  }
  if (tag === "ul" || tag === "ol" || tag === "menu") {
    return serializeList(element);
  }
  if (tag === "table") {
    return serializeTable(element);
  }
  if (tag === "blockquote") {
    return trimSerializedMarkdown(serializeBlocks(element))
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  }
  if (tag === "pre") {
    const code = directChildren(element, "code").find(
      (candidate) => !isOmittedClipboardElement(candidate),
    );
    const rawLanguage = Array.from(code?.classList ?? [])
      .find((name) => /^(?:language|lang)-/.test(name))
      ?.replace(/^(?:language|lang)-/, "");
    const language = rawLanguage && /^[A-Za-z0-9_+.#-]+$/.test(rawLanguage)
      ? rawLanguage
      : "";
    const value = filteredCodeText(element).replace(/\n$/, "");
    const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
    return `${fence}${language}\n${value}\n${fence}`;
  }
  if (tag === "hr") {
    return "---";
  }
  if (tag === "br") {
    return "";
  }

  const hasBlockChildren = Array.from(element.children).some(
    (child) =>
      !isOmittedClipboardElement(child) &&
      blockElementTagPattern.test(child.tagName.toLowerCase()),
  );
  return hasBlockChildren
    ? serializeBlocks(element)
    : escapeMarkdownBlockStarts(
        trimSerializedMarkdown(serializeInlineChildren(element)),
      );
}

function serializeBlocks(element: Element) {
  const pieces: string[] = [];
  let inlineBuffer: Node[] = [];
  const flushInline = () => {
    const value = trimSerializedMarkdown(serializeInlineNodes(inlineBuffer));
    if (value) pieces.push(escapeMarkdownBlockStarts(value));
    inlineBuffer = [];
  };

  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      inlineBuffer.push(node);
      continue;
    }
    if (!(node instanceof Element)) continue;
    if (isOmittedClipboardElement(node)) continue;
    if (
      blockElementTagPattern.test(node.tagName.toLowerCase())
    ) {
      flushInline();
      const block = trimSerializedMarkdown(serializeBlockElement(node));
      if (block) pieces.push(block);
    } else {
      inlineBuffer.push(node);
    }
  }
  flushInline();
  return pieces.join("\n\n");
}

function hasUnsupportedPreBlockChildren(root: Element) {
  return Array.from(root.querySelectorAll("pre")).some(
    (pre) =>
      !hasOmittedClipboardAncestor(pre, root) &&
      Array.from(pre.querySelectorAll("*")).some(
        (element) =>
          element.closest("pre") === pre &&
          !hasOmittedClipboardAncestor(element, pre) &&
          expectedDisplay(element) !== "inline",
      ),
  );
}

function hasUnsupportedCodeContent(root: Element) {
  return Array.from(root.querySelectorAll("code br, code img, pre img")).some(
    (element) => {
      if (hasOmittedClipboardAncestor(element, root)) return false;
      if (element.tagName.toLowerCase() === "img") return true;
      const pre = element.closest("pre");
      return !pre || !root.contains(pre);
    },
  );
}

type InlineBoundaryToken = "block" | "break" | "content";

function edgeInlineBoundaryToken(
  node: Node,
  reverse: boolean,
): InlineBoundaryToken | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return /[^\t\n\f\r ]/.test(node.textContent ?? "") ? "content" : null;
  }
  if (!(node instanceof Element) || isOmittedClipboardElement(node)) return null;

  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "break";
  if (tag === "img") {
    const src = clipboardResourceAttribute(node, "src")?.trim() ?? "";
    return (src && isSafeMarkdownDestination(src, true)) ||
        /[^\t\n\f\r ]/.test(node.getAttribute("alt") ?? "")
      ? "content"
      : null;
  }
  if (tag === "code") return filteredCodeText(node) ? "content" : null;
  if (isSupportedTaskCheckbox(node)) return "content";
  if (expectedDisplay(node) !== "inline") return "block";

  const children = Array.from(node.childNodes);
  if (reverse) children.reverse();
  for (const child of children) {
    const token = edgeInlineBoundaryToken(child, reverse);
    if (token) return token;
  }
  return null;
}

function adjacentInlineBoundaryToken(
  node: Element,
  root: Element,
  reverse: boolean,
) {
  let current: Node = node;
  while (current !== root) {
    for (
      let sibling = reverse ? current.previousSibling : current.nextSibling;
      sibling;
      sibling = reverse ? sibling.previousSibling : sibling.nextSibling
    ) {
      const token = edgeInlineBoundaryToken(sibling, reverse);
      if (token) return token;
    }
    const parent = current.parentElement;
    if (!parent || expectedDisplay(parent) !== "inline") return null;
    current = parent;
  }
  return null;
}

function hasAmbiguousSoftBreak(root: Element) {
  return Array.from(root.querySelectorAll("br")).some((lineBreak) => {
    if (hasOmittedClipboardAncestor(lineBreak, root)) return false;
    if (lineBreak.closest("h1, h2, h3, h4, h5, h6, pre, td, th")) {
      return false;
    }
    return (
      adjacentInlineBoundaryToken(lineBreak, root, true) !== "content" ||
      adjacentInlineBoundaryToken(lineBreak, root, false) !== "content"
    );
  });
}

function hasUnsupportedInlineBlockNesting(root: Element) {
  const pending = Array.from(root.children, (element) => ({
    element,
    hasInlineAncestor: false,
  }));
  while (pending.length > 0) {
    const { element, hasInlineAncestor } = pending.pop()!;
    if (isOmittedClipboardElement(element)) continue;

    const display = expectedDisplay(element);
    if (display !== "inline" && hasInlineAncestor) return true;
    const childHasInlineAncestor = hasInlineAncestor || display === "inline";
    for (const child of element.children) {
      pending.push({ element: child, hasInlineAncestor: childHasInlineAncestor });
    }
  }
  return false;
}

type RichTextMarkdown = {
  block: boolean;
  hasSerializableImage: boolean;
  markdown: string;
  standaloneUrlTarget: string | null;
};

function visibleClipboardText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element) || isOmittedClipboardElement(node)) return "";
  return Array.from(node.childNodes, visibleClipboardText).join("");
}

function standaloneEquivalentAnchorTarget(body: HTMLElement) {
  const anchors = Array.from(body.querySelectorAll("a[href]")).filter(
    (anchor) => !hasOmittedClipboardAncestor(anchor, body),
  );
  if (anchors.length !== 1) return null;

  const anchor = anchors[0];
  const href = anchor.getAttribute("href")?.trim() ?? "";
  if (
    !href ||
    anchor.hasAttribute("title") ||
    Array.from(body.querySelectorAll(meaningfulRichTextSelector)).some(
      (element) =>
        element !== anchor &&
        !hasOmittedClipboardAncestor(element, body),
    ) ||
    Array.from(body.querySelectorAll(blockRichTextSelector)).some(
      (element) => !hasOmittedClipboardAncestor(element, body),
    )
  ) {
    return null;
  }

  const anchorText = visibleClipboardText(anchor).trim();
  return anchorText === href && visibleClipboardText(body).trim() === anchorText
    ? href
    : null;
}

function isMarkdownContainerContext(
  state: EditorState,
  from: number,
  to: number,
  scanBudget: MarkdownContextScanBudget,
) {
  if (scanBudget.exhausted) return true;
  const tree = ensureSyntaxTree(state, Math.max(from, to), 50);
  if (!tree) {
    scanBudget.exhausted = true;
    return true;
  }
  const positions = from === to ? [from] : [from, Math.max(from, to - 1)];
  return positions.some((position) => {
    let node = tree.resolveInner(position, -1);
    while (true) {
      if (node.name !== "Document" && node.name !== "Paragraph") {
        const blockContainer = /^(?:ATXHeading[1-6]|SetextHeading[12]|Blockquote|BulletList|OrderedList|ListItem|Table|TableHeader|TableRow|TableCell|FencedCode|CodeBlock|HTMLBlock|CommentBlock|ProcessingInstructionBlock)$/.test(
          node.name,
        );
        if (
          blockContainer ||
          (node.from < position && node.to > position)
        ) {
          return true;
        }
      }
      if (!node.parent) return false;
      node = node.parent;
    }
  });
}

function isUnsupportedMarkdownInsertionContext(
  state: EditorState,
  from: number,
  to: number,
  scanBudget: MarkdownContextScanBudget,
) {
  const insertionState = from === to
    ? state
    : state.update({ changes: { from, to }, filter: false }).state;
  return (
    isLiteralMarkdownInsertionContext(
      state,
      from,
      to,
      scanBudget,
      insertionState,
    ) ||
    isMarkdownContainerContext(
      insertionState,
      from,
      from,
      scanBudget,
    )
  );
}

function markdownSyntaxSnapshot(source: string, from: number, to: number) {
  const nodes: string[] = [];
  let crossesBoundary = false;
  let endsWithImage = false;
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (node.name === "Document" || node.name === "Paragraph") return;
      if (node.to <= from || node.from >= to) return false;
      if (node.from < from || node.to > to) {
        crossesBoundary = true;
        return false;
      }
      if (node.name === "Image" && node.to === to) endsWithImage = true;
      nodes.push(`${node.name}:${node.from - from}:${node.to - from}`);
    },
  });
  return { crossesBoundary, endsWithImage, nodes };
}

function hasUnparsedFormattingDelimiter(source: string) {
  const parsedDelimiter = new Uint8Array(source.length);
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (
        /^(?:EmphasisMark|StrikethroughMark|Escape|InlineCode|FencedCode|CodeBlock|URL|LinkTitle)$/.test(
          node.name,
        )
      ) {
        parsedDelimiter.fill(1, node.from, node.to);
        return false;
      }
    },
  });
  for (let index = 0; index < source.length; index += 1) {
    if (
      (source[index] === "*" || source[index] === "_" || source[index] === "~") &&
      parsedDelimiter[index] === 0
    ) {
      return true;
    }
  }
  return false;
}

function withoutInlineFormatting(root: HTMLElement) {
  const clone = root.cloneNode(true) as HTMLElement;
  const formatted = Array.from(
    clone.querySelectorAll("b, del, em, i, s, strike, strong"),
  ).reverse();
  for (const element of formatted) {
    element.replaceWith(...Array.from(element.childNodes));
  }
  return clone;
}

function preservesInlineMarkdownSyntax(
  state: EditorState,
  from: number,
  to: number,
  markdown: string,
  scanBudget: MarkdownContextScanBudget,
) {
  if (scanBudget.exhausted || scanBudget.remaining <= 0) {
    scanBudget.exhausted = true;
    return false;
  }
  const line = state.doc.lineAt(from);
  const before = state.doc.sliceString(line.from, from);
  const after = state.doc.sliceString(to, Math.min(state.doc.length, to + 1));
  let precedingBackslashes = 0;
  for (let index = before.length - 2; index >= 0 && before[index] === "\\"; index -= 1) {
    precedingBackslashes += 1;
  }
  const trailingTildeIsEscaped = precedingBackslashes % 2 === 1;
  if (
    (before.endsWith("~") &&
      !trailingTildeIsEscaped &&
      markdown.startsWith("~~")) ||
    (markdown.endsWith("~~") && after.startsWith("~"))
  ) {
    return false;
  }

  const expected = markdownSyntaxSnapshot(markdown, 0, markdown.length);
  const searchEnd = Math.min(
    state.doc.length,
    to + Math.min(MAX_MARKDOWN_BOUNDARY_CONTEXT_LENGTH, scanBudget.remaining),
  );
  const suffix = state.doc.sliceString(to, searchEnd);
  const paragraphBreak = /\n[ \t]*\n/.exec(suffix);
  const consumed = paragraphBreak
    ? paragraphBreak.index + paragraphBreak[0].length
    : suffix.length;
  scanBudget.remaining -= consumed;
  if (!paragraphBreak && searchEnd < state.doc.length) {
    scanBudget.exhausted = true;
    return false;
  }
  if (expected.endsWithImage && parseImageWidthTokenFromText(suffix)) {
    return false;
  }
  const parseTo = paragraphBreak
    ? to + paragraphBreak.index + paragraphBreak[0].length
    : state.doc.length;
  const tree = ensureSyntaxTree(state, parseTo, 50);
  if (!tree) {
    scanBudget.exhausted = true;
    return false;
  }

  const actual = { crossesBoundary: false, nodes: [] as string[] };
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name === "Document" || node.name === "Paragraph") return;
      if (node.to <= from || node.from >= to) return false;
      if (node.from < from || node.to > to) {
        actual.crossesBoundary = true;
        return false;
      }
      actual.nodes.push(`${node.name}:${node.from - from}:${node.to - from}`);
    },
  });
  return (
    !expected.crossesBoundary &&
    !actual.crossesBoundary &&
    expected.nodes.length === actual.nodes.length &&
    expected.nodes.every((node, index) => node === actual.nodes[index])
  );
}

function convertRichTextHtmlToMarkdown(html: string): RichTextMarkdown | null {
  if (
    !html ||
    html.length > MAX_PASTED_TEXT_LENGTH ||
    typeof DOMParser === "undefined" ||
    !html.trim()
  ) {
    return null;
  }
  try {
    const inertHtml = inertClipboardHtml(html);
    if (!inertHtml) return null;
    const document = new DOMParser().parseFromString(inertHtml, "text/html");
    if (exceedsClipboardComplexity(document.documentElement)) return null;
    if (hasUnresolvedStylesheet(document)) return null;
    if (!resolveBaseRelativeDestinations(document)) return null;
    if (hasUnsupportedAllStyle(document.documentElement)) return null;
    if (hasUnsupportedInlineStyleProperty(document.documentElement)) {
      return null;
    }
    if (hasUnsupportedInlineFormattingStyle(document.documentElement)) {
      return null;
    }
    if (hasUnsupportedVisibilityStyle(document.documentElement)) return null;
    if (isOmittedClipboardElement(document.documentElement)) return null;
    if (hasVisibleDescendantOfHiddenElement(document.body)) {
      return null;
    }
    if (hasUnsupportedWhitespaceStyle(document.body)) return null;
    if (hasUnsupportedResponsiveImage(document.body)) return null;
    if (hasUnsupportedImageSizing(document.body)) return null;
    if (hasUnsupportedInteractiveVisibility(document.body)) return null;
    if (hasUnsupportedCodeContent(document.body)) return null;
    if (hasUnsupportedPreBlockChildren(document.body)) return null;
    if (hasAmbiguousSoftBreak(document.body)) return null;
    if (hasUnsupportedInlineBlockNesting(document.body)) return null;
    if (hasVisibleOrphanListItem(document.body)) return null;
    if (
      !Array.from(document.body.querySelectorAll(meaningfulRichTextSelector)).some(
        (element) => !hasOmittedClipboardAncestor(element, document.body),
      )
    ) {
      return null;
    }
    const visibleTables = Array.from(document.body.querySelectorAll("table")).filter(
      (table) => !hasOmittedClipboardAncestor(table, document.body),
    );
    if (visibleTables.some(tableHasUnsupportedShape)) {
      return null;
    }
    const visibleLists = Array.from(document.body.querySelectorAll("menu, ol, ul")).filter(
      (list) => !hasOmittedClipboardAncestor(list, document.body),
    );
    if (visibleLists.some(listHasUnsupportedShape)) {
      return null;
    }
    const hasUnsupportedFormControl = Array.from(
      document.body.querySelectorAll("button, input, select, textarea"),
    ).some(
      (control) =>
        !hasOmittedClipboardAncestor(control, document.body) &&
        !isSupportedTaskCheckbox(control),
    );
    if (hasUnsupportedFormControl) return null;
    let markdown = trimSerializedMarkdown(serializeBlocks(document.body));
    if (!markdown) {
      return null;
    }
    if (hasUnparsedFormattingDelimiter(markdown)) {
      markdown = trimSerializedMarkdown(
        serializeBlocks(withoutInlineFormatting(document.body)),
      );
      if (!markdown || hasUnparsedFormattingDelimiter(markdown)) return null;
    }
    return {
      block:
        Array.from(document.body.querySelectorAll(blockRichTextSelector)).some(
          (element) => !hasOmittedClipboardAncestor(element, document.body),
        ) ||
        markdown.includes("\n\n"),
      hasSerializableImage: Array.from(
        document.body.querySelectorAll("img"),
      ).some(
        (image) => {
          const src = clipboardResourceAttribute(image, "src")?.trim() ?? "";
          return (
            !hasOmittedClipboardAncestor(image, document.body) &&
            Boolean(src) &&
            isSafeMarkdownDestination(src, true)
          );
        },
      ),
      markdown,
      standaloneUrlTarget: standaloneEquivalentAnchorTarget(document.body),
    };
  } catch {
    return null;
  }
}

export function richTextHtmlToMarkdown(html: string) {
  return convertRichTextHtmlToMarkdown(html)?.markdown ?? null;
}

type BlockBoundaryContext = {
  doc: Text;
  exhausted: boolean;
  remaining: number;
};

function createBlockBoundaryContext(state: EditorState): BlockBoundaryContext {
  return {
    doc: state.doc,
    exhausted: false,
    remaining: MAX_BLOCK_BOUNDARY_SCAN_LENGTH,
  };
}

type BlockBoundaryCursor = {
  chunk: string;
  chunkIndex: number;
  context: BlockBoundaryContext;
  iterator: TextIterator;
  reverse: boolean;
  truncated: boolean;
};

function createBlockBoundaryCursor(
  context: BlockBoundaryContext,
  position: number,
  reverse: boolean,
): BlockBoundaryCursor {
  const boundary = reverse
    ? Math.max(0, position - context.remaining)
    : Math.min(context.doc.length, position + context.remaining);
  return {
    chunk: "",
    chunkIndex: 0,
    context,
    iterator: context.doc.iterRange(position, boundary),
    reverse,
    truncated: reverse ? boundary > 0 : boundary < context.doc.length,
  };
}

function readBlockBoundaryCharacter(cursor: BlockBoundaryCursor) {
  while (
    cursor.chunk.length === 0 ||
    (cursor.reverse
      ? cursor.chunkIndex < 0
      : cursor.chunkIndex >= cursor.chunk.length
    )
  ) {
    cursor.iterator.next();
    if (cursor.iterator.done) {
      if (cursor.truncated) cursor.context.exhausted = true;
      return cursor.truncated ? null : undefined;
    }
    cursor.chunk = cursor.iterator.value;
    cursor.chunkIndex = cursor.reverse ? cursor.chunk.length - 1 : 0;
  }

  if (cursor.context.remaining <= 0) {
    cursor.context.exhausted = true;
    return null;
  }
  cursor.context.remaining -= 1;
  const character = cursor.chunk[cursor.chunkIndex];
  cursor.chunkIndex += cursor.reverse ? -1 : 1;
  return character;
}

function blockBoundaryBefore(
  context: BlockBoundaryContext,
  position: number,
) {
  if (position === 0) return "";
  const cursor = createBlockBoundaryCursor(context, position, true);
  let character = readBlockBoundaryCharacter(cursor);
  if (character === null) return null;
  if (character === undefined) return "";

  const allWhitespaceBoundary = character === "\n" ? "" : "\n";
  let phase: "first-line" | "previous-line" = "first-line";
  let localBoundary: "" | "\n" | "\n\n" | undefined;
  while (true) {
    if (localBoundary === undefined) {
      if (character === " " || character === "\t") {
        // Keep looking within this line.
      } else if (phase === "first-line" && character === "\n") {
        phase = "previous-line";
      } else {
        localBoundary = phase === "first-line"
          ? "\n\n"
          : character === "\n"
            ? ""
            : "\n";
      }
    }

    if (character !== " " && character !== "\t" && character !== "\n") {
      return localBoundary!;
    }
    if (localBoundary === allWhitespaceBoundary) return localBoundary;

    character = readBlockBoundaryCharacter(cursor);
    if (character === null) return null;
    if (character === undefined) return allWhitespaceBoundary;
  }
}

function blockBoundaryAfter(
  context: BlockBoundaryContext,
  position: number,
) {
  const cursor = createBlockBoundaryCursor(context, position, false);
  let character = readBlockBoundaryCharacter(cursor);
  if (character === null) return null;
  if (character === undefined) return "";

  let phase: "first-line" | "next-line" = "first-line";
  let localBoundary: "" | "\n" | "\n\n" | undefined;
  while (true) {
    if (localBoundary === undefined) {
      if (character === " " || character === "\t") {
        // Keep looking within this line.
      } else if (phase === "first-line" && character === "\n") {
        phase = "next-line";
      } else {
        localBoundary = phase === "first-line"
          ? "\n\n"
          : character === "\n"
            ? ""
            : "\n";
      }
    }

    if (character !== " " && character !== "\t" && character !== "\n") {
      return localBoundary!;
    }
    if (localBoundary === "") return localBoundary;

    character = readBlockBoundaryCharacter(cursor);
    if (character === null) return null;
    if (character === undefined) return "";
  }
}

function replaceBlockSelections(state: EditorState, markdown: string) {
  const boundaryContext = createBlockBoundaryContext(state);
  const boundaries = state.selection.ranges.map((range) => ({
    after: blockBoundaryAfter(boundaryContext, range.to),
    before: blockBoundaryBefore(boundaryContext, range.from),
  }));
  if (
    boundaryContext.exhausted ||
    boundaries.some(({ after, before }) => after === null || before === null)
  ) {
    return null;
  }

  let rangeIndex = 0;
  return state.changeByRange((range) => {
    const boundary = boundaries[rangeIndex++];
    const insert = `${boundary.before}${markdown}${boundary.after}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
}

type StagedRichTextPaste = {
  converted: RichTextMarkdown;
  rawPlainText: string;
};

type PendingRichTextPaste = StagedRichTextPaste & {
  plainText: string;
};

const markdownRichTextPasteScope = StateField.define<object>({
  create: () => ({}),
  update: (scope) => scope,
});
const stagedRichTextPastes = new WeakMap<object, StagedRichTextPaste>();
const pendingRichTextPastes = new WeakMap<EditorState, PendingRichTextPaste>();

function changeSetsEqual(left: ChangeSet, right: ChangeSet) {
  if (left.length !== right.length || left.newLength !== right.newLength) {
    return false;
  }
  const leftChanges: Array<{
    fromA: number;
    insert: Text;
    toA: number;
  }> = [];
  const rightChanges: typeof leftChanges = [];
  left.iterChanges((fromA, toA, _fromB, _toB, insert) => {
    leftChanges.push({ fromA, insert, toA });
  });
  right.iterChanges((fromA, toA, _fromB, _toB, insert) => {
    rightChanges.push({ fromA, insert, toA });
  });
  return (
    leftChanges.length === rightChanges.length &&
    leftChanges.every(
      (change, index) =>
        change.fromA === rightChanges[index].fromA &&
        change.toA === rightChanges[index].toA &&
        change.insert.eq(rightChanges[index].insert),
    )
  );
}

function matchesUnfilteredNativePaste(
  transaction: Transaction,
  plainText: string,
) {
  const { startState } = transaction;
  const text = startState.toText(plainText);
  let lineNumber = 1;
  const replacement = text.lines === startState.selection.ranges.length
    ? startState.changeByRange((range) => {
        const line = text.line(lineNumber++);
        return {
          changes: { from: range.from, to: range.to, insert: line.text },
          range: EditorSelection.cursor(range.from + line.length),
        };
      })
    : startState.replaceSelection(text);
  const expected = startState.update({ ...replacement, filter: false });
  const linkPasteApplication = transaction.annotation(
    markdownLinkPasteApplication,
  );
  if (linkPasteApplication) {
    return (
      changeSetsEqual(linkPasteApplication.nativeChanges, expected.changes) &&
      changeSetsEqual(linkPasteApplication.resultChanges, transaction.changes)
    );
  }
  return changeSetsEqual(transaction.changes, expected.changes);
}

function clearStagedRichTextPasteSoon(
  scope: object,
  staged: StagedRichTextPaste,
) {
  queueMicrotask(() => {
    if (stagedRichTextPastes.get(scope) === staged) {
      stagedRichTextPastes.delete(scope);
    }
  });
}

function clearPendingRichTextPasteSoon(
  state: EditorState,
  pending: PendingRichTextPaste,
) {
  queueMicrotask(() => {
    if (pendingRichTextPastes.get(state) === pending) {
      pendingRichTextPastes.delete(state);
    }
  });
}

function richTextPasteTransactionSpec(
  state: EditorState,
  pending: PendingRichTextPaste,
): TransactionSpec | null {
  const { converted, plainText } = pending;
  const ranges = state.selection.ranges;
  if (
    ranges.length > MAX_CONTEXTUAL_PASTE_RANGES ||
    ranges.filter((range) => !range.empty).length >
      MAX_CONTEXTUAL_REPLACEMENT_RANGES ||
    plainText.length > MAX_PASTED_TEXT_LENGTH
  ) {
    return null;
  }
  if (
    ranges.length > 1 &&
    state.toText(plainText).lines === ranges.length
  ) {
    return null;
  }

  const standaloneUrl = getStandaloneHttpUrlPaste(plainText);
  const defersToUrlPaste = Boolean(
    standaloneUrl &&
      converted.standaloneUrlTarget === standaloneUrl.url &&
      (standaloneUrl.supportsEmptySelection ||
        ranges.every((range) => !range.empty)),
  );
  if (defersToUrlPaste) return null;

  const scanBudget = createMarkdownContextScanBudget();
  if (
    ranges.some(
      (range) =>
        isUnsupportedMarkdownInsertionContext(
          state,
          range.from,
          range.to,
          scanBudget,
        ),
    ) ||
    scanBudget.exhausted
  ) {
    return null;
  }
  const hasOuterWhitespace = /^\s/u.test(plainText) || /\s$/u.test(plainText);
  if (
    !converted.block &&
    hasOuterWhitespace &&
    !standaloneUrl
  ) {
    return null;
  }
  const markdown =
    !converted.block && standaloneUrl
      ? `${standaloneUrl.before}${converted.markdown}${standaloneUrl.after}`
      : converted.markdown;
  const replacement = converted.block
    ? replaceBlockSelections(state, markdown)
    : state.replaceSelection(markdown);
  if (!replacement) return null;

  const spec: TransactionSpec = {
    ...replacement,
    annotations: Transaction.userEvent.of("input.paste"),
    scrollIntoView: true,
  };
  if (!converted.block) {
    const transaction = state.update({ ...spec, filter: false });
    let preservesSyntax = true;
    transaction.changes.iterChanges(
      (_fromA, _toA, fromB, toB, inserted) => {
        if (
          !preservesInlineMarkdownSyntax(
            transaction.state,
            fromB,
            toB,
            inserted.toString(),
            scanBudget,
          )
        ) {
          preservesSyntax = false;
        }
      },
    );
    if (!preservesSyntax || scanBudget.exhausted) return null;
  }
  return spec;
}

const markdownRichTextDomPaste = Prec.lowest(
  EditorView.domEventHandlers({
    paste(event, view) {
      const clipboardData = event.clipboardData;
      if (
        view.state.readOnly ||
        !clipboardData ||
        clipboardData.files.length > 0
      ) {
        return false;
      }
      const currentRanges = view.state.selection.ranges;
      if (
        currentRanges.length > MAX_CONTEXTUAL_PASTE_RANGES ||
        currentRanges.filter((range) => !range.empty).length >
          MAX_CONTEXTUAL_REPLACEMENT_RANGES
      ) {
        // This stale-state check can only make us fall back to the native
        // path, which will flush the DOM before applying the paste.
        return false;
      }
      const plainText =
        clipboardData.getData("text/plain") ||
        clipboardData.getData("text/uri-list");
      if (plainText.length > MAX_PASTED_TEXT_LENGTH) return false;
      const html = clipboardData.getData("text/html");
      if (html.length > MAX_PASTED_TEXT_LENGTH) return false;
      const converted = convertRichTextHtmlToMarkdown(html);
      if (!converted) return false;

      const scope = view.state.field(markdownRichTextPasteScope, false);
      if (!scope) return false;
      const staged = { converted, rawPlainText: plainText };
      stagedRichTextPastes.set(scope, staged);
      clearStagedRichTextPasteSoon(scope, staged);
      // CodeMirror's native paste handler now flushes pending DOM and
      // selection mutations before it runs the clipboard input filters.
      return false;
    },
  }),
);

const markdownRichTextClipboardInput = Prec.lowest(
  EditorView.clipboardInputFilter.of((plainText, state) => {
    const scope = state.field(markdownRichTextPasteScope, false);
    if (!scope) return plainText;
    const staged = stagedRichTextPastes.get(scope);
    if (!staged) return plainText;

    stagedRichTextPastes.delete(scope);
    const pending = { ...staged, plainText };
    pendingRichTextPastes.set(state, pending);
    clearPendingRichTextPasteSoon(state, pending);
    return plainText;
  }),
);

const markdownRichTextTransactionPaste = Prec.lowest(
  EditorState.transactionFilter.of((tr) => {
    if (tr.annotation(Transaction.userEvent) !== "input.paste") return tr;
    const pending = pendingRichTextPastes.get(tr.startState);
    if (!pending) return tr;
    pendingRichTextPastes.delete(tr.startState);

    if (
      pending.rawPlainText !== pending.plainText ||
      !matchesUnfilteredNativePaste(tr, pending.plainText)
    ) {
      return tr;
    }

    // A replacement transaction would not be re-run through change filters.
    // Preserve the already-filtered native paste whenever an editor has one.
    if (tr.startState.facet(EditorState.changeFilter).length > 0) return tr;
    return richTextPasteTransactionSpec(tr.startState, pending) ?? tr;
  }),
);

export const markdownRichTextPaste = [
  markdownRichTextPasteScope,
  markdownRichTextDomPaste,
  markdownRichTextClipboardInput,
  markdownRichTextTransactionPaste,
];
