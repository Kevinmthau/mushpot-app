"use client";

import {
  DOCUMENT_HTML_STYLES,
  renderDocumentHtmlBody,
} from "@/components/editor/document-html-renderer";
import {
  inferMediaMimeType,
  normalizeMediaMimeType,
} from "@/components/editor/image-upload-utils";
import { parseDocumentMediaCandidate } from "@/lib/document-media";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

type DocumentHtmlSnapshot = {
  title: string;
  content: string;
  owner: string;
};

type DocumentHtmlExportOptions = {
  signal?: AbortSignal;
};

const MEDIA_ERROR =
  "Unable to include uploaded media. Check your connection and access to this document, then try Download HTML again.";

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function readMediaDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      reader.abort();
      cleanup();
      reject(signal?.reason ?? new DOMException("Export cancelled.", "AbortError"));
    };
    reader.onload = () => {
      cleanup();
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error(MEDIA_ERROR));
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error(MEDIA_ERROR));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      reader.readAsDataURL(blob);
    } catch {
      cleanup();
      reject(new Error(MEDIA_ERROR));
    }
  });
}

function getMediaMimeType(blob: Blob, storagePath: string) {
  const declaredType = blob.type.split(";", 1)[0].trim().toLowerCase();
  const mimeType = normalizeMediaMimeType(declaredType)?.mimeType;
  if (mimeType) return mimeType;
  if (!declaredType || declaredType === "application/octet-stream") {
    const inferredType = inferMediaMimeType(storagePath);
    if (inferredType) return inferredType;
  }
  throw new Error(MEDIA_ERROR);
}

function resolveUrl(source: string, baseUrl: string) {
  try {
    return new URL(source, baseUrl);
  } catch {
    // A broken external destination is still safe after Markdown URL filtering.
    // Preserve it rather than preventing the rest of the document's export.
    return null;
  }
}

function normalizeManagedSource(source: string, baseUrl: string) {
  const url = resolveUrl(source, baseUrl);
  return url && url.origin === new URL(baseUrl).origin && url.pathname.startsWith("/m/")
    ? `${url.pathname}${url.search}${url.hash}`
    : source;
}

async function embedMedia(
  container: HTMLElement,
  owner: string,
  baseUrl: string,
  signal?: AbortSignal,
) {
  const embedded = new Map<string, string>();
  let supabase: SupabaseBrowserClient | undefined;

  for (const element of container.querySelectorAll<HTMLElement>("[data-export-src]")) {
    for (const attribute of ["src", "poster"] as const) {
      throwIfAborted(signal);
      const source = element.getAttribute(`data-export-${attribute}`);
      if (!source) continue;
      const normalized = normalizeManagedSource(source, baseUrl);
      const candidate = parseDocumentMediaCandidate(
        normalized,
        process.env.NEXT_PUBLIC_SUPABASE_URL,
      );
      let resolved: string;

      if (candidate.status === "invalid") throw new Error(MEDIA_ERROR);
      if (candidate.status === "media") {
        const media = candidate.media;
        if (media.ownerId !== owner) {
          throw new Error("Unable to include media owned by another account.");
        }
        const key = `${media.bucket}\0${media.storagePath}`;
        let dataUrl = embedded.get(key);
        if (!dataUrl) {
          if (!supabase) {
            const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
            throwIfAborted(signal);
            supabase = await getSupabaseBrowserClient();
          }
          throwIfAborted(signal);
          const { data, error } = await supabase.storage
            .from(media.bucket)
            .download(media.storagePath, undefined, { signal, cache: "no-store" });
          throwIfAborted(signal);
          if (error || !data) throw new Error(MEDIA_ERROR);
          const mimeType = getMediaMimeType(data, media.storagePath);
          dataUrl = await readMediaDataUrl(data.slice(0, data.size, mimeType), signal);
          embedded.set(key, dataUrl);
        }
        resolved = dataUrl + (resolveUrl(source, baseUrl)?.hash ?? "");
      } else {
        // Relative destinations must still work when the file is opened locally.
        resolved = resolveUrl(source, baseUrl)?.href ?? source;
      }

      element.setAttribute(attribute, resolved);
      element.removeAttribute(`data-export-${attribute}`);
    }
  }
}

export async function exportDocumentHtml(
  { title, content, owner }: DocumentHtmlSnapshot,
  { signal }: DocumentHtmlExportOptions = {},
): Promise<{ html: string; filename: string }> {
  throwIfAborted(signal);
  const displayTitle = title.trim() || "Untitled";
  const rendered = renderDocumentHtmlBody({ title: displayTitle, content });

  try {
    const baseUrl = window.location.href;
    await embedMedia(rendered.container, owner, baseUrl, signal);
    throwIfAborted(signal);
    for (const anchor of rendered.container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const href = anchor.getAttribute("href");
      if (href && !href.startsWith("#")) {
        anchor.setAttribute("href", resolveUrl(href, baseUrl)?.href ?? href);
      }
    }

    const htmlDocument = document.implementation.createHTMLDocument(displayTitle);
    htmlDocument.documentElement.lang = "en";
    const charset = htmlDocument.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    htmlDocument.head.prepend(charset);
    const viewport = htmlDocument.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1";
    htmlDocument.head.append(viewport);
    const style = htmlDocument.createElement("style");
    style.textContent = DOCUMENT_HTML_STYLES;
    htmlDocument.head.append(style);
    for (const child of Array.from(rendered.container.childNodes)) {
      htmlDocument.body.append(child.cloneNode(true));
    }

    const filename = displayTitle
      .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, "_")
      .replace(/[. ]+$/g, "") || "Untitled";
    return {
      html: `<!doctype html>\n${htmlDocument.documentElement.outerHTML}`,
      filename: `${filename}.html`,
    };
  } finally {
    rendered.dispose();
  }
}
