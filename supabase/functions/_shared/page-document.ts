// Dependency-free page-document validation for the Deno Edge runtime. Keep the
// accepted wire format aligned with lib/page-document.ts, but do not import the
// application/Tiptap module into an Edge Function.
export const MARKDOWN_CONTENT_FORMAT = "markdown_v1" as const;
export const PAGE_JSON_CONTENT_FORMAT = "page_json_v1" as const;

export type DocumentContentFormat =
  | typeof MARKDOWN_CONTENT_FORMAT
  | typeof PAGE_JSON_CONTENT_FORMAT;

export type PageDocumentMediaReference = Readonly<{
  attribute: "src" | "poster";
  nodeType: "image" | "video";
  path: readonly number[];
  url: string;
}>;

type UnknownRecord = Record<string, unknown>;
type PageNode = {
  attrs?: UnknownRecord;
  content?: PageNode[];
  marks?: UnknownRecord[];
  text?: string;
  type: string;
};
type PageDocument = {
  content: PageNode;
  schema: "mushpot.page";
  theme: "paper" | "editorial";
  version: 1;
  width: "prose" | "wide";
};
type ValidationState = {
  active: WeakSet<object>;
  nodeCount: number;
  textLength: number;
};

const MAX_SERIALIZED_LENGTH = 1_500_000;
const MAX_NODES = 5_000;
const MAX_DEPTH = 64;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_URL_LENGTH = 8_192;
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

export class EdgePageDocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgePageDocumentValidationError";
  }
}

function invalid(path: string, message: string): never {
  throw new EdgePageDocumentValidationError(
    `Invalid page document at ${path}: ${message}`,
  );
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
  options: { allowEmpty?: boolean; maxLength?: number } = {},
) {
  const {
    allowEmpty = true,
    maxLength = MAX_SHORT_TEXT_LENGTH,
  } = options;
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
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    invalid(path, `expected an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function isSafeRelativeUrl(value: string, allowFragment: boolean) {
  if (allowFragment && value.startsWith("#")) return value.length > 1;
  if (value.startsWith("//")) return false;

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

function hasForbiddenUrlCharacters(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || character === "\\") {
      return true;
    }
  }
  return false;
}

function isSafeUrl(
  value: unknown,
  protocols: ReadonlySet<string>,
  allowFragment: boolean,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    value !== value.trim() ||
    hasForbiddenUrlCharacters(value)
  ) {
    return false;
  }

  if (!/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) {
    return isSafeRelativeUrl(value, allowFragment);
  }

  try {
    const url = new URL(value);
    return (
      protocols.has(url.protocol) &&
      ((url.protocol !== "http:" && url.protocol !== "https:") ||
        Boolean(url.hostname)) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isSafeLinkUrl(value: unknown): value is string {
  return isSafeUrl(
    value,
    new Set(["http:", "https:", "mailto:", "tel:"]),
    true,
  );
}

function isSafeMediaUrl(value: unknown): value is string {
  return isSafeUrl(value, new Set(["http:", "https:"]), false);
}

function canonicalizeLinkAttributes(value: unknown, path: string) {
  const attrs = readRecord(value, path);
  assertExactKeys(
    attrs,
    new Set(["href", "title", "target", "rel", "class"]),
    path,
  );
  if (!isSafeLinkUrl(attrs.href)) invalid(`${path}.href`, "unsafe URL");
  const title = readOptionalString(attrs.title, `${path}.title`);
  if (
    attrs.target !== undefined &&
    attrs.target !== null &&
    attrs.target !== "_blank"
  ) {
    invalid(`${path}.target`, "unsupported link target");
  }
  if (
    attrs.rel !== undefined &&
    attrs.rel !== null &&
    attrs.rel !== "noopener noreferrer"
  ) {
    invalid(`${path}.rel`, "unsupported link relationship");
  }
  if (attrs.class !== undefined && attrs.class !== null) {
    invalid(`${path}.class`, "link classes are not supported");
  }
  return { href: attrs.href, ...(title === null ? {} : { title }) };
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
    const type = readString(mark.type, `${markPath}.type`, {
      allowEmpty: false,
    });
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

function canonicalizeNodeAttributes(
  type: string,
  value: unknown,
  path: string,
): UnknownRecord | undefined {
  const attrs = value === undefined ? {} : readRecord(value, path);
  let canonical: UnknownRecord;

  switch (type) {
    case "heading": {
      assertExactKeys(attrs, new Set(["level"]), path);
      canonical = {
        level: readInteger(attrs.level ?? 1, `${path}.level`, 1, 3),
      };
      break;
    }
    case "orderedList": {
      assertExactKeys(attrs, new Set(["start", "type"]), path);
      const start = readInteger(
        attrs.start ?? 1,
        `${path}.start`,
        1,
        1_000_000,
      );
      const listType = attrs.type;
      if (
        listType !== undefined &&
        listType !== null &&
        !["1", "a", "A", "i", "I"].includes(String(listType))
      ) {
        invalid(`${path}.type`, "unsupported ordered-list style");
      }
      canonical = {
        ...(start === 1 ? {} : { start }),
        ...(listType === undefined || listType === null || listType === "1"
          ? {}
          : { type: listType }),
      };
      break;
    }
    case "codeBlock": {
      assertExactKeys(attrs, new Set(["language"]), path);
      const language = readOptionalString(
        attrs.language,
        `${path}.language`,
        MAX_CODE_LANGUAGE_LENGTH,
      );
      if (language !== null && !/^[A-Za-z\d_+.#-]+$/u.test(language)) {
        invalid(`${path}.language`, "contains unsupported characters");
      }
      canonical = language === null ? {} : { language };
      break;
    }
    case "tableCell":
    case "tableHeader": {
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
        if (
          !Array.isArray(attrs.colwidth) || attrs.colwidth.length !== colspan
        ) {
          invalid(
            `${path}.colwidth`,
            "must contain one width per spanned column",
          );
        }
        colwidth = attrs.colwidth.map((width, index) =>
          readInteger(
            width,
            `${path}.colwidth[${index}]`,
            1,
            MAX_MEDIA_DIMENSION,
          )
        );
      }
      canonical = {
        ...(colspan === 1 ? {} : { colspan }),
        ...(rowspan === 1 ? {} : { rowspan }),
        ...(colwidth === undefined ? {} : { colwidth }),
        ...(align === undefined || align === null ? {} : { align }),
      };
      break;
    }
    case "image":
    case "video": {
      if (value === undefined) invalid(path, "is required");
      assertExactKeys(
        attrs,
        type === "image"
          ? new Set(["src", "alt", "title", "width", "height"])
          : new Set(["src", "poster", "alt", "width"]),
        path,
      );
      if (!isSafeMediaUrl(attrs.src)) {
        invalid(`${path}.src`, "unsafe media URL");
      }
      const alt = readOptionalString(attrs.alt, `${path}.alt`);
      const width = attrs.width === undefined || attrs.width === null
        ? null
        : readInteger(attrs.width, `${path}.width`, 1, MAX_MEDIA_DIMENSION);
      if (type === "image") {
        const title = readOptionalString(attrs.title, `${path}.title`);
        const height = attrs.height === undefined || attrs.height === null
          ? null
          : readInteger(
            attrs.height,
            `${path}.height`,
            1,
            MAX_MEDIA_DIMENSION,
          );
        canonical = {
          src: attrs.src,
          ...(alt === null ? {} : { alt }),
          ...(title === null ? {} : { title }),
          ...(width === null ? {} : { width }),
          ...(height === null ? {} : { height }),
        };
      } else {
        const poster = attrs.poster;
        if (
          poster !== undefined &&
          poster !== null &&
          !isSafeMediaUrl(poster)
        ) {
          invalid(`${path}.poster`, "unsafe media URL");
        }
        canonical = {
          src: attrs.src,
          ...(poster === undefined || poster === null ? {} : { poster }),
          ...(alt === null ? {} : { alt }),
          ...(width === null ? {} : { width }),
        };
      }
      break;
    }
    default:
      if (value !== undefined) assertExactKeys(attrs, new Set(), path);
      return undefined;
  }

  return Object.keys(canonical).length === 0 ? undefined : canonical;
}

function validateChildren(type: string, children: PageNode[], path: string) {
  const every = (
    predicate: (child: PageNode) => boolean,
    description: string,
  ) => {
    if (!children.every(predicate)) invalid(`${path}.content`, description);
  };

  switch (type) {
    case "doc":
      if (children.length === 0) {
        invalid(`${path}.content`, "must contain a block");
      }
      every(
        (child) => BLOCK_NODE_TYPES.has(child.type),
        "may contain only block nodes",
      );
      return;
    case "paragraph":
    case "heading":
      every(
        (child) => INLINE_NODE_TYPES.has(child.type),
        "may contain only inline nodes",
      );
      return;
    case "blockquote":
    case "tableCell":
    case "tableHeader":
      if (children.length === 0) {
        invalid(`${path}.content`, "must contain a block");
      }
      every(
        (child) => BLOCK_NODE_TYPES.has(child.type),
        "may contain only block nodes",
      );
      return;
    case "bulletList":
    case "orderedList":
      if (children.length === 0) {
        invalid(`${path}.content`, "must contain a list item");
      }
      every(
        (child) => child.type === "listItem",
        "may contain only list items",
      );
      return;
    case "listItem":
      if (children.length === 0 || children[0].type !== "paragraph") {
        invalid(`${path}.content`, "must begin with a paragraph");
      }
      every(
        (child) => BLOCK_NODE_TYPES.has(child.type),
        "may contain only block nodes",
      );
      return;
    case "codeBlock":
      every(
        (child) => child.type === "text" && !child.marks,
        "may contain only unmarked text",
      );
      return;
    case "table":
      if (children.length === 0) {
        invalid(`${path}.content`, "must contain a row");
      }
      every((child) => child.type === "tableRow", "may contain only rows");
      return;
    case "tableRow":
      if (children.length === 0) {
        invalid(`${path}.content`, "must contain a cell");
      }
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
): PageNode {
  if (depth > MAX_DEPTH) invalid(path, "is nested too deeply");
  const node = readRecord(value, path);
  if (state.active.has(node)) invalid(path, "contains a cycle");
  state.active.add(node);

  try {
    state.nodeCount += 1;
    if (state.nodeCount > MAX_NODES) invalid(path, "contains too many nodes");
    const type = readString(node.type, `${path}.type`, { allowEmpty: false });
    if (!ALL_NODE_TYPES.has(type)) invalid(`${path}.type`, "unknown node type");

    if (type === "text") {
      assertExactKeys(node, new Set(["type", "text", "marks"]), path);
      const text = readString(node.text, `${path}.text`, {
        allowEmpty: false,
        maxLength: MAX_TEXT_LENGTH,
      });
      state.textLength += text.length;
      if (state.textLength > MAX_TEXT_LENGTH) {
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

    const leaf = type === "horizontalRule" || type === "image" ||
      type === "video";
    assertExactKeys(
      node,
      leaf ? new Set(["type", "attrs"]) : new Set(["type", "attrs", "content"]),
      path,
    );
    const attrs = canonicalizeNodeAttributes(type, node.attrs, `${path}.attrs`);
    let children: PageNode[] = [];
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) {
        invalid(`${path}.content`, "expected an array");
      }
      if (node.content.length > MAX_NODES) {
        invalid(`${path}.content`, "contains too many nodes");
      }
      children = node.content.map((child, index) =>
        canonicalizeNode(child, `${path}.content[${index}]`, depth + 1, state)
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

function canonicalizePageDocument(value: unknown): PageDocument {
  const envelope = readRecord(value, "$page");
  assertExactKeys(
    envelope,
    new Set(["schema", "version", "theme", "width", "content"]),
    "$page",
  );
  if (envelope.schema !== "mushpot.page") {
    invalid("$page.schema", "unknown schema");
  }
  if (envelope.version !== 1) invalid("$page.version", "unsupported version");
  if (envelope.theme !== "paper" && envelope.theme !== "editorial") {
    invalid("$page.theme", "unsupported theme");
  }
  if (envelope.width !== "prose" && envelope.width !== "wide") {
    invalid("$page.width", "unsupported width");
  }
  const content = canonicalizeNode(envelope.content, "$page.content", 0, {
    active: new WeakSet(),
    nodeCount: 0,
    textLength: 0,
  });
  if (content.type !== "doc") invalid("$page.content.type", "must be doc");
  return {
    schema: "mushpot.page",
    version: 1,
    theme: envelope.theme,
    width: envelope.width,
    content,
  };
}

export function parsePersistedDocumentContentFormat(
  value: unknown,
): DocumentContentFormat | null {
  // Older rows selected by a newly deployed function can omit the column.
  if (value === undefined) return MARKDOWN_CONTENT_FORMAT;
  if (value === MARKDOWN_CONTENT_FORMAT || value === PAGE_JSON_CONTENT_FORMAT) {
    return value;
  }
  return null;
}

export function parseEdgePageDocument(serialized: string): PageDocument {
  if (
    typeof serialized !== "string" ||
    serialized.length === 0 ||
    serialized.length > MAX_SERIALIZED_LENGTH
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

function visitMedia(
  node: PageNode,
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
    visitMedia(child, [...path, index], visitor);
  });
}

export function getEdgePageDocumentMedia(serialized: string) {
  const document = parseEdgePageDocument(serialized);
  const references: PageDocumentMediaReference[] = [];
  visitMedia(document.content, [], (reference) => references.push(reference));
  return references;
}

async function rewriteNodeMedia(
  node: PageNode,
  path: readonly number[],
  rewrite: (
    reference: PageDocumentMediaReference,
  ) => Promise<string> | string,
): Promise<PageNode> {
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
        rewriteNodeMedia(child, [...path, index], rewrite)
      ),
    )
    : undefined;
  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(content ? { content } : {}),
  };
}

export async function rewriteEdgePageDocumentMedia(
  serialized: string,
  rewrite: (
    reference: PageDocumentMediaReference,
  ) => Promise<string> | string,
) {
  const document = parseEdgePageDocument(serialized);
  const rewritten = canonicalizePageDocument({
    ...document,
    content: await rewriteNodeMedia(document.content, [], rewrite),
  });
  const result = JSON.stringify(rewritten);
  if (result.length > MAX_SERIALIZED_LENGTH) {
    invalid("$page", "serialized content is too long");
  }
  return result;
}
