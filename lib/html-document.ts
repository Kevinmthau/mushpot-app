import {
  defaultTreeAdapter,
  parse,
  serialize,
  type DefaultTreeAdapterTypes,
} from "parse5";

export const HTML_CONTENT_MAX_BYTES = 2 * 1024 * 1024;
export const HTML_FULL_HIGHLIGHT_MAX_BYTES = 512 * 1024;

export const HTML_PREVIEW_SANDBOX = "";
export const HTML_INTERACTIVE_PREVIEW_SANDBOX = "allow-scripts";

const HTML_PREVIEW_CSP_BASE = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
] as const;

const HIDDEN_TEXT_ELEMENTS = new Set([
  "head",
  "style",
  "script",
  "template",
  "noscript",
  "license",
]);
const BLOCK_TEXT_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

export class HtmlDocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlDocumentValidationError";
  }
}

export function getUtf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function isHtmlDocumentTextFragmentValid(value: string) {
  return !value.includes("\0") && !hasUnpairedSurrogate(value);
}

export function validateHtmlDocumentSource(source: string) {
  if (typeof source !== "string" || source.length === 0) {
    throw new HtmlDocumentValidationError("HTML documents cannot be empty.");
  }
  if (source.includes("\0")) {
    throw new HtmlDocumentValidationError("HTML documents cannot contain NUL bytes.");
  }
  if (hasUnpairedSurrogate(source)) {
    throw new HtmlDocumentValidationError("HTML documents must be valid UTF-8.");
  }
  if (getUtf8ByteLength(source) > HTML_CONTENT_MAX_BYTES) {
    throw new HtmlDocumentValidationError("HTML documents must be 2 MiB or smaller.");
  }
  return source;
}

export function decodeHtmlDocumentBytes(bytes: Uint8Array) {
  if (bytes.byteLength === 0) {
    throw new HtmlDocumentValidationError("HTML documents cannot be empty.");
  }
  if (bytes.byteLength > HTML_CONTENT_MAX_BYTES) {
    throw new HtmlDocumentValidationError("HTML documents must be 2 MiB or smaller.");
  }

  let source: string;
  try {
    // Preserve an optional UTF-8 BOM as U+FEFF so downloading the untouched
    // source emits the exact accepted bytes again.
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new HtmlDocumentValidationError("HTML documents must be valid UTF-8.");
  }
  return validateHtmlDocumentSource(source);
}

export async function decodeHtmlDocumentFile(
  file: Pick<File, "arrayBuffer" | "size">,
) {
  if (file.size === 0) {
    throw new HtmlDocumentValidationError("HTML documents cannot be empty.");
  }
  if (file.size > HTML_CONTENT_MAX_BYTES) {
    throw new HtmlDocumentValidationError(
      "HTML documents must be 2 MiB or smaller.",
    );
  }
  return decodeHtmlDocumentBytes(new Uint8Array(await file.arrayBuffer()));
}

function isElement(
  node: DefaultTreeAdapterTypes.Node,
): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node;
}

function getAttributes(node: DefaultTreeAdapterTypes.Element) {
  return Object.fromEntries(
    node.attrs.map(({ name, value }) => [name.toLowerCase(), value]),
  );
}

function directText(node: DefaultTreeAdapterTypes.Element) {
  return node.childNodes
    .map((child) => ("value" in child ? child.value : ""))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function isLicenseElement(node: DefaultTreeAdapterTypes.Element) {
  const attrs = getAttributes(node);
  const labels = [attrs.id, attrs.class, attrs.role, attrs["aria-label"]]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/u);
  return labels.includes("license") || labels.includes("licence") ||
    labels.includes("licenses") || labels.includes("licences");
}

function findHtmlElement(
  document: DefaultTreeAdapterTypes.Document,
  tagName: string,
) {
  const nodes: DefaultTreeAdapterTypes.Node[] = [...document.childNodes];
  while (nodes.length > 0) {
    const node = nodes.shift()!;
    if (isElement(node) && node.tagName === tagName) return node;
    if ("childNodes" in node) nodes.unshift(...node.childNodes);
  }
  return null;
}

function appendVisibleText(
  node: DefaultTreeAdapterTypes.Node,
  output: string[],
) {
  if ("value" in node) {
    output.push(node.value);
    return;
  }
  if (!isElement(node)) {
    if ("childNodes" in node) {
      for (const child of node.childNodes) appendVisibleText(child, output);
    }
    return;
  }
  if (
    node.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
    HIDDEN_TEXT_ELEMENTS.has(node.tagName) ||
    isLicenseElement(node)
  ) {
    return;
  }

  const block = BLOCK_TEXT_ELEMENTS.has(node.tagName);
  if (block) output.push("\n");
  for (const child of node.childNodes) appendVisibleText(child, output);
  if (block) output.push("\n");
}

export type HtmlDocumentMetadata = Readonly<{
  description: string;
  title: string;
  visibleText: string;
}>;

export function getHtmlDocumentMetadata(source: string): HtmlDocumentMetadata {
  validateHtmlDocumentSource(source);
  const document = parse(source);
  let title = "";
  let description = "";
  const nodes: DefaultTreeAdapterTypes.Node[] = [...document.childNodes];

  while (nodes.length > 0) {
    const node = nodes.shift()!;
    if (isElement(node) && node.namespaceURI === "http://www.w3.org/1999/xhtml") {
      if (node.tagName === "title" && !title) title = directText(node);
      if (node.tagName === "meta" && !description) {
        const attrs = getAttributes(node);
        if (attrs.name?.toLowerCase() === "description") {
          description = (attrs.content ?? "").replace(/\s+/gu, " ").trim();
        }
      }
      if (node.tagName === "template" || node.tagName === "noscript") continue;
    }
    if ("childNodes" in node) nodes.push(...node.childNodes);
  }

  const visibleParts: string[] = [];
  const body = findHtmlElement(document, "body");
  if (body) appendVisibleText(body, visibleParts);
  const visibleText = visibleParts
    .join("")
    .replace(/[\t\r ]+/gu, " ")
    .replace(/ *\n+ */gu, "\n")
    .trim();

  return { description, title, visibleText };
}

export function getHtmlImportTitle(source: string, filename: string) {
  const title = getHtmlDocumentMetadata(source).title.trim();
  if (title) return title;
  const fallback = filename.replace(/\.(?:html?|xhtml)$/iu, "").trim();
  return fallback || "Untitled";
}

function removePreviewNavigationNodes(document: DefaultTreeAdapterTypes.Document) {
  const nodes: DefaultTreeAdapterTypes.Node[] = [...document.childNodes];
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    if (isElement(node)) {
      const attrs = getAttributes(node);
      const remove = node.tagName === "base" ||
        (node.tagName === "meta" && attrs["http-equiv"]?.toLowerCase() === "refresh");
      if (remove) {
        defaultTreeAdapter.detachNode(node);
        continue;
      }
    }
    if ("childNodes" in node) nodes.push(...node.childNodes);
  }
}

export function getHtmlPreviewCsp(interactionsEnabled: boolean) {
  return [
    ...HTML_PREVIEW_CSP_BASE,
    interactionsEnabled ? "script-src 'unsafe-inline'" : "script-src 'none'",
  ].join("; ");
}

/** Build a disposable preview copy. The returned string is never persisted. */
export function buildHtmlPreviewDocument(
  source: string,
  interactionsEnabled = false,
) {
  validateHtmlDocumentSource(source);
  const document = parse(source);
  removePreviewNavigationNodes(document);
  const csp = getHtmlPreviewCsp(interactionsEnabled);
  const head = findHtmlElement(document, "head");
  if (!head) {
    throw new HtmlDocumentValidationError("HTML preview has no document head.");
  }
  const cspMeta = defaultTreeAdapter.createElement(
    "meta",
    head.namespaceURI,
    [
      { name: "http-equiv", value: "Content-Security-Policy" },
      { name: "content", value: csp },
    ],
  );
  const firstChild = defaultTreeAdapter.getFirstChild(head);
  if (firstChild) {
    defaultTreeAdapter.insertBefore(head, cspMeta, firstChild);
  } else {
    defaultTreeAdapter.appendChild(head, cspMeta);
  }

  // parse5 always materializes an HTML head for a document parse. Inserting a
  // real node avoids string-boundary ambiguity in author-supplied attributes
  // and guarantees the CSP precedes resources moved into the head.
  return serialize(document);
}
