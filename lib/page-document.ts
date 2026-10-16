import type { JSONContent } from "@tiptap/core";

import { getHtmlDocumentMetadata } from "@/lib/html-document";

export const MARKDOWN_CONTENT_FORMAT = "markdown_v1" as const;
export const PAGE_JSON_CONTENT_FORMAT = "page_json_v1" as const;
export const HTML_CONTENT_FORMAT = "html_v1" as const;

/**
 * Sent with authenticated PostgREST requests so database policies can keep a
 * page row hidden from an older client that would interpret its JSON as
 * Markdown. Keep the value a comma-separated capability list for future
 * additive formats.
 */
export const DOCUMENT_CONTENT_FORMATS_HEADER =
  "x-mushpot-content-formats" as const;
export const DOCUMENT_CONTENT_FORMATS_CAPABILITY =
  `${MARKDOWN_CONTENT_FORMAT},${PAGE_JSON_CONTENT_FORMAT},${HTML_CONTENT_FORMAT}` as const;

export type DocumentContentFormat =
  | typeof MARKDOWN_CONTENT_FORMAT
  | typeof PAGE_JSON_CONTENT_FORMAT
  | typeof HTML_CONTENT_FORMAT;

export const PAGE_DOCUMENT_SCHEMA = "mushpot.page" as const;
export const PAGE_DOCUMENT_VERSION = 1 as const;

export const PAGE_DOCUMENT_THEMES = ["paper", "editorial"] as const;
export const PAGE_DOCUMENT_WIDTHS = ["prose", "wide"] as const;

export type PageDocumentTheme = (typeof PAGE_DOCUMENT_THEMES)[number];
export type PageDocumentWidth = (typeof PAGE_DOCUMENT_WIDTHS)[number];

export type PageDocumentV1 = Readonly<{
  schema: typeof PAGE_DOCUMENT_SCHEMA;
  version: typeof PAGE_DOCUMENT_VERSION;
  theme: PageDocumentTheme;
  width: PageDocumentWidth;
  content: JSONContent;
}>;

export type PageDocumentMediaNodeType = "image" | "video";
export type PageDocumentMediaAttribute = "src" | "poster";

export type PageDocumentMediaReference = Readonly<{
  nodeType: PageDocumentMediaNodeType;
  attribute: PageDocumentMediaAttribute;
  url: string;
  /** Child indexes from the Tiptap `doc` node to the owning media node. */
  path: readonly number[];
}>;

export const MAX_PAGE_DOCUMENT_SERIALIZED_LENGTH = 1_500_000;
export const MAX_PAGE_DOCUMENT_NODES = 5_000;
export const MAX_PAGE_DOCUMENT_DEPTH = 64;
export const MAX_PAGE_DOCUMENT_TEXT_LENGTH = 1_000_000;
export const MAX_PAGE_DOCUMENT_URL_LENGTH = 8_192;

const MAX_SHORT_TEXT_LENGTH = 2_048;
const MAX_CODE_LANGUAGE_LENGTH = 64;
const MAX_MEDIA_DIMENSION = 8_192;
const MAX_TABLE_SPAN = 100;

const BLOCK_NODE_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "codeBlock",
  "horizontalRule",
  "image",
  "video",
  "table",
]);
const INLINE_NODE_TYPES = new Set(["text", "hardBreak"]);
const SIMPLE_MARK_TYPES = new Set([
  "bold",
  "italic",
  "strike",
  "underline",
  "code",
]);
const MARK_ORDER = new Map([
  ["bold", 0],
  ["italic", 1],
  ["strike", 2],
  ["underline", 3],
  ["link", 4],
  ["code", 5],
]);
const ALL_NODE_TYPES = new Set([
  "doc",
  ...BLOCK_NODE_TYPES,
  ...INLINE_NODE_TYPES,
  "listItem",
  "tableRow",
  "tableCell",
  "tableHeader",
]);

type UnknownRecord = Record<string, unknown>;
type CanonicalNode = JSONContent & { type: string };

type ValidationState = {
  active: WeakSet<object>;
  nodeCount: number;
  textLength: number;
};

export class PageDocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageDocumentValidationError";
  }
}

function invalid(path: string, message: string): never {
  throw new PageDocumentValidationError(`Invalid page document at ${path}: ${message}`);
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecord(value: unknown, path: string): UnknownRecord {
  if (!isPlainRecord(value)) invalid(path, "expected an object");
  return value;
}

function assertExactKeys(
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
  path: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, "unknown field");
  }
}

function readString(
  value: unknown,
  path: string,
  { allowEmpty = true, maxLength = MAX_SHORT_TEXT_LENGTH } = {},
) {
  if (typeof value !== "string") invalid(path, "expected a string");
  if (!allowEmpty && value.length === 0) invalid(path, "must not be empty");
  if (value.length > maxLength) invalid(path, "is too long");
  return value;
}

function readOptionalString(
  value: unknown,
  path: string,
  maxLength = MAX_SHORT_TEXT_LENGTH,
) {
  if (value === undefined || value === null) return null;
  return readString(value, path, { maxLength });
}

function readInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(path, `expected an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function hasForbiddenUrlCharacters(value: string) {
  return /[\u0000-\u0020\u007f\\]/u.test(value);
}

function parseAllowedAbsoluteUrl(
  value: string,
  protocols: ReadonlySet<string>,
) {
  try {
    const url = new URL(value);
    if (!protocols.has(url.protocol)) return false;
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) {
      return false;
    }
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

function isSafeRelativeUrl(value: string, allowFragment: boolean) {
  if (allowFragment && value.startsWith("#")) return value.length > 1;
  if (value.startsWith("//")) return false;

  // A colon before a path/query/fragment delimiter is a URL scheme. Schemes
  // are handled separately so obfuscated or unknown schemes fail closed.
  const firstDelimiter = value.search(/[/?#]/u);
  const firstColon = value.indexOf(":");
  if (firstColon >= 0 && (firstDelimiter < 0 || firstColon < firstDelimiter)) {
    return false;
  }

  try {
    new URL(value, "https://mushpot.invalid/");
    return true;
  } catch {
    return false;
  }
}

function isSafeUrl(
  value: unknown,
  protocols: ReadonlySet<string>,
  allowFragment: boolean,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PAGE_DOCUMENT_URL_LENGTH ||
    value !== value.trim() ||
    hasForbiddenUrlCharacters(value)
  ) {
    return false;
  }

  return /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)
    ? parseAllowedAbsoluteUrl(value, protocols)
    : isSafeRelativeUrl(value, allowFragment);
}

/** Links are limited to navigational protocols and safe relative URLs. */
export function isSafePageLinkUrl(value: unknown): value is string {
  return isSafeUrl(
    value,
    new Set(["http:", "https:", "mailto:", "tel:"]),
    true,
  );
}

/** Persisted media may be remote HTTP(S) or an app-relative managed path. */
export function isSafePageMediaUrl(value: unknown): value is string {
  return isSafeUrl(value, new Set(["http:", "https:"]), false);
}

export function normalizeDocumentContentFormat(
  value: unknown,
): DocumentContentFormat {
  if (value === undefined || value === null) {
    return MARKDOWN_CONTENT_FORMAT;
  }

  return parseDocumentContentFormat(value);
}

/** Strict counterpart for trust boundaries where unknown formats must fail. */
export function parseDocumentContentFormat(
  value: unknown,
): DocumentContentFormat {
  if (
    value === MARKDOWN_CONTENT_FORMAT ||
    value === PAGE_JSON_CONTENT_FORMAT ||
    value === HTML_CONTENT_FORMAT
  ) {
    return value;
  }
  throw new PageDocumentValidationError("Invalid document content format");
}

function canonicalizeLinkAttributes(value: unknown, path: string) {
  const attrs = readRecord(value, path);
  assertExactKeys(
    attrs,
    new Set(["href", "title", "target", "rel", "class"]),
    path,
  );

  if (!isSafePageLinkUrl(attrs.href)) invalid(`${path}.href`, "unsafe URL");
  const title = readOptionalString(attrs.title, `${path}.title`);

  // Tiptap carries these presentation attributes through rich HTML paste.
  // They are renderer policy rather than document content: validate their
  // shape, then discard them so pasted `_self`, `nofollow`, or source-site
  // classes can never override the safe attributes supplied by our renderer.
  readOptionalString(attrs.target, `${path}.target`);
  readOptionalString(attrs.rel, `${path}.rel`);
  readOptionalString(attrs.class, `${path}.class`);

  return {
    href: attrs.href,
    ...(title === null ? {} : { title }),
  };
}

function canonicalizeMarks(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid(path, "expected an array");
  if (value.length === 0) return undefined;

  const seen = new Set<string>();
  const marks = value.map((candidate, index) => {
    const markPath = `${path}[${index}]`;
    const mark = readRecord(candidate, markPath);
    assertExactKeys(mark, new Set(["type", "attrs"]), markPath);
    const type = readString(mark.type, `${markPath}.type`, { allowEmpty: false });
    if (seen.has(type)) invalid(`${markPath}.type`, "duplicate mark");
    seen.add(type);

    if (SIMPLE_MARK_TYPES.has(type)) {
      if (mark.attrs !== undefined) {
        const attrs = readRecord(mark.attrs, `${markPath}.attrs`);
        assertExactKeys(attrs, new Set(), `${markPath}.attrs`);
      }
      return { type };
    }

    if (type === "link") {
      if (mark.attrs === undefined) invalid(`${markPath}.attrs`, "is required");
      return {
        type,
        attrs: canonicalizeLinkAttributes(mark.attrs, `${markPath}.attrs`),
      };
    }

    return invalid(`${markPath}.type`, "unknown mark type");
  });

  if (seen.has("code") && marks.length > 1) {
    invalid(path, "the code mark cannot be combined with other marks");
  }

  return marks.sort(
    (left, right) =>
      (MARK_ORDER.get(left.type) ?? Number.MAX_SAFE_INTEGER) -
      (MARK_ORDER.get(right.type) ?? Number.MAX_SAFE_INTEGER),
  );
}

function canonicalizeHeadingAttributes(value: unknown, path: string) {
  const attrs = value === undefined ? {} : readRecord(value, path);
  assertExactKeys(attrs, new Set(["level"]), path);
  return { level: readInteger(attrs.level ?? 1, `${path}.level`, 1, 3) };
}

function canonicalizeOrderedListAttributes(value: unknown, path: string) {
  const attrs = value === undefined ? {} : readRecord(value, path);
  assertExactKeys(attrs, new Set(["start", "type"]), path);
  const start = readInteger(attrs.start ?? 1, `${path}.start`, 1, 1_000_000);
  const listType = attrs.type;
  if (
    listType !== undefined &&
    listType !== null &&
    !["1", "a", "A", "i", "I"].includes(String(listType))
  ) {
    invalid(`${path}.type`, "unsupported ordered-list style");
  }
  return {
    ...(start === 1 ? {} : { start }),
    ...(listType === undefined || listType === null || listType === "1"
      ? {}
      : { type: listType as string }),
  };
}

function canonicalizeCodeBlockAttributes(value: unknown, path: string) {
  const attrs = value === undefined ? {} : readRecord(value, path);
  assertExactKeys(attrs, new Set(["language"]), path);
  const language = readOptionalString(
    attrs.language,
    `${path}.language`,
    MAX_CODE_LANGUAGE_LENGTH,
  );
  if (language !== null && !/^[A-Za-z\d_+.#-]+$/u.test(language)) {
    invalid(`${path}.language`, "contains unsupported characters");
  }
  return language === null ? {} : { language };
}

function canonicalizeTableCellAttributes(value: unknown, path: string) {
  const attrs = value === undefined ? {} : readRecord(value, path);
  assertExactKeys(
    attrs,
    new Set(["colspan", "rowspan", "colwidth", "align"]),
    path,
  );
  const colspan = readInteger(
    attrs.colspan ?? 1,
    `${path}.colspan`,
    1,
    MAX_TABLE_SPAN,
  );
  const rowspan = readInteger(
    attrs.rowspan ?? 1,
    `${path}.rowspan`,
    1,
    MAX_TABLE_SPAN,
  );
  const align = attrs.align;
  if (
    align !== undefined &&
    align !== null &&
    align !== "left" &&
    align !== "center" &&
    align !== "right"
  ) {
    invalid(`${path}.align`, "unsupported table-cell alignment");
  }

  let colwidth: number[] | undefined;
  if (attrs.colwidth !== undefined && attrs.colwidth !== null) {
    if (!Array.isArray(attrs.colwidth) || attrs.colwidth.length !== colspan) {
      invalid(`${path}.colwidth`, "must contain one width per spanned column");
    }
    colwidth = attrs.colwidth.map((width, index) =>
      readInteger(
        width,
        `${path}.colwidth[${index}]`,
        1,
        MAX_MEDIA_DIMENSION,
      ),
    );
  }

  return {
    ...(colspan === 1 ? {} : { colspan }),
    ...(rowspan === 1 ? {} : { rowspan }),
    ...(colwidth === undefined ? {} : { colwidth }),
    ...(align === undefined || align === null ? {} : { align }),
  };
}

function canonicalizeMediaAttributes(
  nodeType: PageDocumentMediaNodeType,
  value: unknown,
  path: string,
) {
  const attrs = readRecord(value, path);
  const allowed = nodeType === "image"
    ? new Set(["src", "alt", "title", "width", "height"])
    : new Set(["src", "poster", "alt", "width"]);
  assertExactKeys(attrs, allowed, path);

  if (!isSafePageMediaUrl(attrs.src)) invalid(`${path}.src`, "unsafe media URL");
  const alt = readOptionalString(attrs.alt, `${path}.alt`);
  const width = attrs.width === undefined || attrs.width === null
    ? null
    : readInteger(attrs.width, `${path}.width`, 1, MAX_MEDIA_DIMENSION);

  if (nodeType === "image") {
    const title = readOptionalString(attrs.title, `${path}.title`);
    const height = attrs.height === undefined || attrs.height === null
      ? null
      : readInteger(attrs.height, `${path}.height`, 1, MAX_MEDIA_DIMENSION);
    return {
      src: attrs.src,
      ...(alt === null ? {} : { alt }),
      ...(title === null ? {} : { title }),
      ...(width === null ? {} : { width }),
      ...(height === null ? {} : { height }),
    };
  }

  const poster = attrs.poster;
  if (
    poster !== undefined &&
    poster !== null &&
    !isSafePageMediaUrl(poster)
  ) {
    invalid(`${path}.poster`, "unsafe media URL");
  }
  return {
    src: attrs.src,
    ...(poster === undefined || poster === null ? {} : { poster }),
    ...(alt === null ? {} : { alt }),
    ...(width === null ? {} : { width }),
  };
}

function canonicalizeNodeAttributes(
  type: string,
  value: unknown,
  path: string,
): UnknownRecord | undefined {
  let attrs: UnknownRecord;
  switch (type) {
    case "heading":
      attrs = canonicalizeHeadingAttributes(value, path);
      break;
    case "orderedList":
      attrs = canonicalizeOrderedListAttributes(value, path);
      break;
    case "codeBlock":
      attrs = canonicalizeCodeBlockAttributes(value, path);
      break;
    case "tableCell":
    case "tableHeader":
      attrs = canonicalizeTableCellAttributes(value, path);
      break;
    case "image":
    case "video":
      if (value === undefined) invalid(path, "is required");
      attrs = canonicalizeMediaAttributes(type, value, path);
      break;
    default:
      if (value !== undefined) {
        attrs = readRecord(value, path);
        assertExactKeys(attrs, new Set(), path);
      }
      return undefined;
  }
  return Object.keys(attrs).length === 0 ? undefined : attrs;
}

function validateChildren(type: string, children: CanonicalNode[], path: string) {
  const every = (predicate: (child: CanonicalNode) => boolean, description: string) => {
    if (!children.every(predicate)) invalid(`${path}.content`, description);
  };

  switch (type) {
    case "doc":
      if (children.length === 0) invalid(`${path}.content`, "must contain a block");
      every((child) => BLOCK_NODE_TYPES.has(child.type), "may contain only block nodes");
      return;
    case "paragraph":
    case "heading":
      every((child) => INLINE_NODE_TYPES.has(child.type), "may contain only inline nodes");
      return;
    case "blockquote":
    case "tableCell":
    case "tableHeader":
      if (children.length === 0) invalid(`${path}.content`, "must contain a block");
      every((child) => BLOCK_NODE_TYPES.has(child.type), "may contain only block nodes");
      return;
    case "bulletList":
    case "orderedList":
      if (children.length === 0) invalid(`${path}.content`, "must contain a list item");
      every((child) => child.type === "listItem", "may contain only list items");
      return;
    case "listItem":
      if (children.length === 0 || children[0].type !== "paragraph") {
        invalid(`${path}.content`, "must begin with a paragraph");
      }
      every((child) => BLOCK_NODE_TYPES.has(child.type), "may contain only block nodes");
      return;
    case "codeBlock":
      every(
        (child) => child.type === "text" && !child.marks,
        "may contain only unmarked text",
      );
      return;
    case "table":
      if (children.length === 0) invalid(`${path}.content`, "must contain a row");
      every((child) => child.type === "tableRow", "may contain only rows");
      return;
    case "tableRow":
      if (children.length === 0) invalid(`${path}.content`, "must contain a cell");
      every(
        (child) => child.type === "tableCell" || child.type === "tableHeader",
        "may contain only table cells",
      );
      return;
    default:
      if (children.length !== 0) invalid(`${path}.content`, "is not allowed");
  }
}

function canonicalizeNode(
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
): CanonicalNode {
  if (depth > MAX_PAGE_DOCUMENT_DEPTH) invalid(path, "is nested too deeply");
  const node = readRecord(value, path);
  if (state.active.has(node)) invalid(path, "contains a cycle");
  state.active.add(node);

  try {
    state.nodeCount += 1;
    if (state.nodeCount > MAX_PAGE_DOCUMENT_NODES) {
      invalid(path, "contains too many nodes");
    }

    const type = readString(node.type, `${path}.type`, { allowEmpty: false });
    if (!ALL_NODE_TYPES.has(type)) invalid(`${path}.type`, "unknown node type");

    if (type === "text") {
      assertExactKeys(node, new Set(["type", "text", "marks"]), path);
      const text = readString(node.text, `${path}.text`, {
        allowEmpty: false,
        maxLength: MAX_PAGE_DOCUMENT_TEXT_LENGTH,
      });
      state.textLength += text.length;
      if (state.textLength > MAX_PAGE_DOCUMENT_TEXT_LENGTH) {
        invalid(`${path}.text`, "document text is too long");
      }
      const marks = canonicalizeMarks(node.marks, `${path}.marks`);
      return { type, ...(marks ? { marks } : {}), text };
    }

    if (type === "hardBreak") {
      assertExactKeys(node, new Set(["type", "marks"]), path);
      const marks = canonicalizeMarks(node.marks, `${path}.marks`);
      return { type, ...(marks ? { marks } : {}) };
    }

    const leaf = type === "horizontalRule" || type === "image" || type === "video";
    assertExactKeys(
      node,
      leaf ? new Set(["type", "attrs"]) : new Set(["type", "attrs", "content"]),
      path,
    );
    const attrs = canonicalizeNodeAttributes(type, node.attrs, `${path}.attrs`);

    let children: CanonicalNode[] = [];
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) invalid(`${path}.content`, "expected an array");
      if (node.content.length > MAX_PAGE_DOCUMENT_NODES) {
        invalid(`${path}.content`, "contains too many nodes");
      }
      children = node.content.map((child, index) =>
        canonicalizeNode(child, `${path}.content[${index}]`, depth + 1, state),
      );
    }
    validateChildren(type, children, path);

    return {
      type,
      ...(attrs ? { attrs } : {}),
      ...(children.length === 0 ? {} : { content: children }),
    };
  } finally {
    state.active.delete(node);
  }
}

function readAllowlistedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(path, `expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Validate and rebuild a page document into one deterministic key order. */
export function canonicalizePageDocument(value: unknown): PageDocumentV1 {
  const envelope = readRecord(value, "$page");
  assertExactKeys(
    envelope,
    new Set(["schema", "version", "theme", "width", "content"]),
    "$page",
  );
  if (envelope.schema !== PAGE_DOCUMENT_SCHEMA) {
    invalid("$page.schema", "unknown schema");
  }
  if (envelope.version !== PAGE_DOCUMENT_VERSION) {
    invalid("$page.version", "unsupported version");
  }

  const theme = readAllowlistedValue(
    envelope.theme,
    PAGE_DOCUMENT_THEMES,
    "$page.theme",
  );
  const width = readAllowlistedValue(
    envelope.width,
    PAGE_DOCUMENT_WIDTHS,
    "$page.width",
  );
  const content = canonicalizeNode(envelope.content, "$page.content", 0, {
    active: new WeakSet(),
    nodeCount: 0,
    textLength: 0,
  });
  if (content.type !== "doc") invalid("$page.content.type", "must be doc");

  const canonical: PageDocumentV1 = {
    schema: PAGE_DOCUMENT_SCHEMA,
    version: PAGE_DOCUMENT_VERSION,
    theme,
    width,
    content,
  };
  if (JSON.stringify(canonical).length > MAX_PAGE_DOCUMENT_SERIALIZED_LENGTH) {
    invalid("$page", "serialized content is too long");
  }
  return canonical;
}

/** Parse a serialized page document. Malformed and unsupported input throws. */
export function parsePageDocument(serialized: string): PageDocumentV1 {
  if (typeof serialized !== "string") {
    invalid("$page", "expected serialized JSON");
  }
  if (
    serialized.length === 0 ||
    serialized.length > MAX_PAGE_DOCUMENT_SERIALIZED_LENGTH
  ) {
    invalid("$page", "serialized content has an invalid length");
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    invalid("$page", "malformed JSON");
  }
  return canonicalizePageDocument(value);
}

/** Serialize only after validation so equivalent accepted input is stable. */
export function serializePageDocument(value: unknown): string {
  const serialized = JSON.stringify(canonicalizePageDocument(value));
  if (serialized.length > MAX_PAGE_DOCUMENT_SERIALIZED_LENGTH) {
    invalid("$page", "serialized content is too long");
  }
  return serialized;
}

export function createEmptyPageDocument(
  options: Partial<Pick<PageDocumentV1, "theme" | "width">> = {},
): PageDocumentV1 {
  return canonicalizePageDocument({
    schema: PAGE_DOCUMENT_SCHEMA,
    version: PAGE_DOCUMENT_VERSION,
    theme: options.theme ?? "paper",
    width: options.width ?? "prose",
    content: {
      type: "doc",
      content: [{ type: "paragraph" }],
    },
  });
}

export const EMPTY_PAGE_DOCUMENT = createEmptyPageDocument();
export const EMPTY_PAGE_DOCUMENT_CONTENT = serializePageDocument(
  EMPTY_PAGE_DOCUMENT,
);

function extractNodeText(node: CanonicalNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "image" || node.type === "video") {
    return typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
  }
  if (node.type === "horizontalRule") return "";

  const children = (node.content ?? []) as CanonicalNode[];
  if (node.type === "table") return children.map(extractNodeText).join("\n");
  if (node.type === "tableRow") return children.map(extractNodeText).join("\t");
  if (
    node.type === "doc" ||
    node.type === "blockquote" ||
    node.type === "tableCell" ||
    node.type === "tableHeader"
  ) {
    return children.map(extractNodeText).filter(Boolean).join("\n\n");
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    return children.map(extractNodeText).filter(Boolean).join("\n");
  }
  if (node.type === "listItem") {
    return children.map(extractNodeText).filter(Boolean).join("\n");
  }
  return children.map(extractNodeText).join("");
}

/** Plain text used for reading time, previews, search, and accessibility. */
export function getPageDocumentPlainText(value: unknown) {
  const document = canonicalizePageDocument(value);
  return extractNodeText(document.content as CanonicalNode).trim();
}

/** Project either persisted format to plain text for non-editor consumers. */
export function getDocumentPlainText(
  content: string,
  contentFormat: DocumentContentFormat,
) {
  const format = parseDocumentContentFormat(contentFormat);
  switch (format) {
    case MARKDOWN_CONTENT_FORMAT:
      return content;
    case PAGE_JSON_CONTENT_FORMAT:
      return getPageDocumentPlainText(parsePageDocument(content));
    case HTML_CONTENT_FORMAT:
      return getHtmlDocumentMetadata(content).visibleText;
  }
}

function visitMediaNodes(
  node: CanonicalNode,
  path: readonly number[],
  visitor: (reference: PageDocumentMediaReference) => void,
) {
  if (node.type === "image" || node.type === "video") {
    const src = node.attrs?.src;
    if (typeof src === "string") {
      visitor({ nodeType: node.type, attribute: "src", url: src, path });
    }
    const poster = node.attrs?.poster;
    if (node.type === "video" && typeof poster === "string") {
      visitor({ nodeType: node.type, attribute: "poster", url: poster, path });
    }
  }

  node.content?.forEach((child, index) => {
    visitMediaNodes(child as CanonicalNode, [...path, index], visitor);
  });
}

/** Return only typed image/video URL attributes; prose and link URLs are ignored. */
export function getPageDocumentMedia(value: unknown) {
  const document = canonicalizePageDocument(value);
  const references: PageDocumentMediaReference[] = [];
  visitMediaNodes(document.content as CanonicalNode, [], (reference) => {
    references.push(reference);
  });
  return references;
}

function rewriteMediaNode(
  node: CanonicalNode,
  path: readonly number[],
  rewrite: (reference: PageDocumentMediaReference) => string,
): CanonicalNode {
  let attrs = node.attrs;
  if (node.type === "image" || node.type === "video") {
    attrs = { ...attrs };
    for (const attribute of ["src", "poster"] as const) {
      const url = attrs[attribute];
      if (
        typeof url !== "string" ||
        (attribute === "poster" && node.type !== "video")
      ) {
        continue;
      }
      attrs[attribute] = rewrite({
        nodeType: node.type,
        attribute,
        url,
        path,
      });
    }
  }

  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(node.content
      ? {
          content: node.content.map((child, index) =>
            rewriteMediaNode(
              child as CanonicalNode,
              [...path, index],
              rewrite,
            ),
          ),
        }
      : {}),
  };
}

/** Rewrite only image/video URL attributes, then validate every replacement. */
export function rewritePageDocumentMedia(
  value: unknown,
  rewrite: (reference: PageDocumentMediaReference) => string,
) {
  const document = canonicalizePageDocument(value);
  return canonicalizePageDocument({
    ...document,
    content: rewriteMediaNode(document.content as CanonicalNode, [], rewrite),
  });
}

async function rewriteMediaNodeAsync(
  node: CanonicalNode,
  path: readonly number[],
  rewrite: (reference: PageDocumentMediaReference) => Promise<string> | string,
): Promise<CanonicalNode> {
  let attrs = node.attrs;
  if (node.type === "image" || node.type === "video") {
    attrs = { ...attrs };
    for (const attribute of ["src", "poster"] as const) {
      const url = attrs[attribute];
      if (
        typeof url !== "string" ||
        (attribute === "poster" && node.type !== "video")
      ) {
        continue;
      }
      attrs[attribute] = await rewrite({
        nodeType: node.type,
        attribute,
        url,
        path,
      });
    }
  }

  const content = node.content
    ? await Promise.all(
        node.content.map((child, index) =>
          rewriteMediaNodeAsync(
            child as CanonicalNode,
            [...path, index],
            rewrite,
          ),
        ),
      )
    : undefined;
  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(content ? { content } : {}),
  };
}

/** Async counterpart for signing or embedding typed media URLs. */
export async function rewritePageDocumentMediaAsync(
  value: unknown,
  rewrite: (
    reference: PageDocumentMediaReference,
  ) => Promise<string> | string,
) {
  const document = canonicalizePageDocument(value);
  return canonicalizePageDocument({
    ...document,
    content: await rewriteMediaNodeAsync(
      document.content as CanonicalNode,
      [],
      rewrite,
    ),
  });
}
