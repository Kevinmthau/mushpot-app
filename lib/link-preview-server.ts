import { Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  defaultTreeAdapter,
  Parser,
  Tokenizer,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
} from "parse5";
import type { LinkPreviewMetadata } from "@/lib/link-preview";

const MAX_URL_LENGTH = 4096;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_HTML_DEPTH = 128;
const MAX_HTML_NODE_OPERATIONS = 10_000;
const MAX_TAG_ATTRIBUTES = 128;
const PARSE_CHUNK_SIZE = 1024;
const MAX_PARSE_TIME_MS = 250;
const REQUEST_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const MAX_CONCURRENT_REQUESTS = 8;
const MAX_REQUESTS_PER_MINUTE = 60;
const MAX_CACHE_ENTRIES = 256;
const SUCCESS_CACHE_MS = 60 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const blockedIPv4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIPv4.addSubnet(address, prefix, "ipv4");
}

const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
const blockedIPv6 = new BlockList();
// Restrict IPv6 to global unicast and exclude protocol, transition, and
// documentation ranges. This also excludes mapped IPv4 and NAT64 addresses.
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blockedIPv6.addSubnet(address, prefix, "ipv6");
}

export class LinkPreviewError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "LinkPreviewError";
  }
}

function unavailable() {
  return new LinkPreviewError(502, "Link preview unavailable.");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIPv4.check(address, "ipv4");
  return family === 6 && globalIPv6.check(address, "ipv6") &&
    !blockedIPv6.check(address, "ipv6");
}

export function validateLinkPreviewUrl(value: string): URL {
  let url: URL;
  try {
    if (!value || value.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f]/.test(value)) {
      throw new Error();
    }
    url = new URL(value);
  } catch {
    throw new LinkPreviewError(400, "A public HTTP or HTTPS URL is required.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const invalidHost = !hostname.includes(".") && !isIP(hostname) ||
    /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(hostname);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
    (url.port && url.port !== "80" && url.port !== "443") || invalidHost ||
    (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new LinkPreviewError(400, "A public HTTP or HTTPS URL is required.");
  }
  url.hash = "";
  return url;
}

async function resolvePublicAddress(url: URL, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };

  signal.throwIfAborted();
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal.throwIfAborted();
    const addresses = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (addresses.length === 0) throw unavailable();
    // Reject mixed public/private answers as well, before opening any socket.
    if (addresses.some((address) => !isPublicAddress(address))) {
      throw new LinkPreviewError(400, "A public HTTP or HTTPS URL is required.");
    }
    return { address: addresses[0], family: isIP(addresses[0]) };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

type HtmlResponse = { html: string } | { location: string };

async function requestHtml(url: URL, signal: AbortSignal): Promise<HtmlResponse> {
  const resolved = await resolvePublicAddress(url, signal);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      agent: false,
      signal,
      maxHeaderSize: 16 * 1024,
      family: resolved.family,
      // The socket must use the address we checked, not resolve the host again.
      // Keeping the original URL preserves TLS hostname checks and the Host header.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      },
      headers: {
        "User-Agent": "Mushpot-Link-Preview/1.0",
        Accept: "text/html, application/xhtml+xml",
        "Accept-Encoding": "identity",
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status) && response.headers.location) {
        resolve({ location: response.headers.location });
        response.destroy();
        return;
      }
      const contentType = response.headers["content-type"] ?? "";
      const encoding = response.headers["content-encoding"];
      if (status < 200 || status >= 300 ||
        !/^(text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(contentType) ||
        (encoding && encoding !== "identity")) {
        reject(unavailable());
        response.destroy();
        return;
      }

      const decoder = new StringDecoder("utf8");
      let bytes = 0;
      let html = "";
      response.on("data", (chunk: Buffer) => {
        const prefix = chunk.subarray(0, MAX_HTML_BYTES - bytes);
        bytes += prefix.length;
        html += decoder.write(prefix);
        // Frameworks can stream metadata after </head>. Keep a bounded prefix
        // of the body too, retaining useful metadata even on larger pages.
        if (bytes === MAX_HTML_BYTES) {
          resolve({ html: html + decoder.end() });
          response.destroy();
        }
      });
      response.on("end", () => resolve({ html: html + decoder.end() }));
      response.on("error", reject);
      response.on("aborted", () => reject(unavailable()));
    });
    req.on("error", reject);
    req.end();
  });
}

function cleanText(value: string | undefined, maxLength: number): string | undefined {
  return value?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) || undefined;
}

class PreviewTokenizer extends Tokenizer {
  protected override _leaveAttrName() {
    // parse5 checks each new attribute against the existing list. Bound it
    // before that scan, rather than waiting for the complete start-tag token.
    const token = this.currentToken;
    if (token && "attrs" in token && token.attrs.length >= MAX_TAG_ATTRIBUTES) {
      throw unavailable();
    }
    super._leaveAttrName();
  }
}

function parsePreviewHtml(html: string) {
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw unavailable();
  let depth = 0;
  let nodeOperations = 0;
  const countNodeOperation = () => {
    if (++nodeOperations > MAX_HTML_NODE_OPERATIONS) throw unavailable();
  };
  const parser = new Parser<DefaultTreeAdapterMap>({
    treeAdapter: {
      ...defaultTreeAdapter,
      createElement(...args) {
        countNodeOperation();
        return defaultTreeAdapter.createElement(...args);
      },
      createCommentNode(...args) {
        countNodeOperation();
        return defaultTreeAdapter.createCommentNode(...args);
      },
      insertText(...args) {
        countNodeOperation();
        return defaultTreeAdapter.insertText(...args);
      },
      insertTextBefore(...args) {
        countNodeOperation();
        return defaultTreeAdapter.insertTextBefore(...args);
      },
      onItemPush() {
        if (++depth > MAX_HTML_DEPTH) throw unavailable();
      },
      onItemPop() { depth--; },
    },
  });
  // Use parse5's tokenizer hook so scripts, raw text, templates, and foreign
  // content retain the same HTML semantics as the normal document parser.
  parser.tokenizer = new PreviewTokenizer(parser.options, parser);
  const deadline = performance.now() + MAX_PARSE_TIME_MS;
  for (let offset = 0; offset < html.length; offset += PARSE_CHUNK_SIZE) {
    parser.tokenizer.write(
      html.slice(offset, offset + PARSE_CHUNK_SIZE),
      offset + PARSE_CHUNK_SIZE >= html.length,
    );
    // A timer cannot interrupt synchronous parsing. Check elapsed time between
    // small chunks as well as bounding the parser's expensive data structures.
    if (performance.now() > deadline) throw unavailable();
  }
  return parser.document;
}

export function extractLinkPreviewMetadata(html: string, url: URL): LinkPreviewMetadata {
  const document = parsePreviewHtml(html);
  const values = new Map<string, string>();
  let title = "";
  const nodes: DefaultTreeAdapterTypes.Node[] = [...document.childNodes].reverse();
  while (nodes.length) {
    const node = nodes.pop()!;
    // Read actual HTML tags, including streamed body metadata, in document
    // order. Inert content and SVG/MathML titles are not page metadata.
    if ("tagName" in node && (node.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      node.tagName === "template" || node.tagName === "noscript")) continue;
    if ("tagName" in node && node.tagName === "meta") {
      const attrs = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
      const key = (attrs.property || attrs.name || "").toLowerCase();
      if (attrs.content && !values.has(key)) values.set(key, attrs.content);
    }
    if ("tagName" in node && node.tagName === "title" && !title) {
      title = node.childNodes.map((child) => "value" in child ? child.value : "").join("");
    }
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        nodes.push(node.childNodes[index]);
      }
    }
  }

  let image: string | undefined;
  const imageValue = values.get("og:image:secure_url") || values.get("og:image") || values.get("twitter:image");
  if (imageValue) {
    try {
      const imageUrl = validateLinkPreviewUrl(new URL(imageValue, url).href);
      // The app's image CSP permits HTTPS. HTTP images would fail to render.
      if (imageUrl.protocol === "https:") image = imageUrl.href;
    } catch {
      // Invalid images are optional; the text preview is still useful.
    }
  }
  return {
    url: url.href,
    title: cleanText(values.get("og:title") || values.get("twitter:title") || title, 300) || url.hostname,
    description: cleanText(values.get("og:description") || values.get("twitter:description") || values.get("description"), 500),
    siteName: cleanText(values.get("og:site_name"), 100),
    image,
  };
}

type CacheEntry = {
  expiresAt: number;
} & ({ metadata: LinkPreviewMetadata } | { error: LinkPreviewError });
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<LinkPreviewMetadata>>();
let requestWindowStart = 0;
let requestCount = 0;

function cacheResult(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

async function fetchMetadata(url: URL): Promise<LinkPreviewMetadata> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let currentUrl = url;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const result = await requestHtml(currentUrl, controller.signal);
      if ("html" in result) return extractLinkPreviewMetadata(result.html, currentUrl);
      currentUrl = validateLinkPreviewUrl(new URL(result.location, currentUrl).href);
    }
    throw unavailable();
  } catch (error) {
    if (error instanceof LinkPreviewError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timeout);
  }
}

export async function getLinkPreview(value: string): Promise<LinkPreviewMetadata> {
  const url = validateLinkPreviewUrl(value);
  const key = url.href;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    if ("error" in cached) throw cached.error;
    return cached.metadata;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (now - requestWindowStart >= 60 * 1000) {
    requestWindowStart = now;
    requestCount = 0;
  }
  // Bound both simultaneous work and sustained misses per server instance.
  if (inFlight.size >= MAX_CONCURRENT_REQUESTS || requestCount >= MAX_REQUESTS_PER_MINUTE) {
    throw new LinkPreviewError(429, "Link previews are busy. Try again shortly.");
  }
  requestCount++;
  const result = fetchMetadata(url)
    .then((metadata) => {
      cacheResult(key, { metadata, expiresAt: Date.now() + SUCCESS_CACHE_MS });
      return metadata;
    })
    .catch((error: LinkPreviewError) => {
      cacheResult(key, { error, expiresAt: Date.now() + FAILURE_CACHE_MS });
      throw error;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, result);
  return result;
}
