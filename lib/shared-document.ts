import { cache } from "react";
import { headers } from "next/headers";

import { resolveAppOriginFromHeaders } from "@/lib/app-url";
import {
  DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS,
  type SharedMediaBatchResponse,
} from "@/lib/document-media";

export type SharedDocument = {
  title: string;
  content: string;
  updated_at: string;
};

const DEFAULT_SHARED_DOCUMENT_DESCRIPTION =
  "Open this shared document in Mushpot.";

export type SharedDocumentResult<T> =
  | { status: "success"; data: T }
  | { status: "not_found" }
  | { status: "unavailable" };

export type SharedMediaBatch = SharedMediaBatchResponse;

async function requestSharedDocument<T>(
  body: Record<string, string | string[]>,
  parse: (payload: unknown) => T | null,
): Promise<SharedDocumentResult<T>> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return { status: "unavailable" };

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/get-shared-doc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404 || response.status === 400) return { status: "not_found" };
    if (!response.ok) return { status: "unavailable" };
    const data = parse(await response.json());
    return data === null ? { status: "unavailable" } : { status: "success", data };
  } catch {
    // Network, timeout, configuration, and malformed responses are retryable.
    // Never log the bearer token or a signed media URL.
    return { status: "unavailable" };
  }
}

function parseSignedUrl(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.origin === new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  const truncatedValue = value.slice(0, maxLength - 1).trimEnd();
  const lastWordBoundary = truncatedValue.lastIndexOf(" ");

  if (lastWordBoundary > maxLength * 0.6) {
    return `${truncatedValue.slice(0, lastWordBoundary).trimEnd()}…`;
  }

  return `${truncatedValue}…`;
}

function stripMarkdownForPreview(content: string) {
  return content
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, "")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/\*\*|__|\*|_|~~/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSharedDocumentTitle(title: string) {
  return title.trim() || "Untitled";
}

export function buildSharedDocumentPreview(content: string, maxLength = 180) {
  const plainText = stripMarkdownForPreview(content);

  if (!plainText) {
    return DEFAULT_SHARED_DOCUMENT_DESCRIPTION;
  }

  return truncateText(plainText, maxLength);
}

export const fetchSharedDocument = cache(
  async (id: string, token: string): Promise<SharedDocumentResult<SharedDocument>> =>
    requestSharedDocument({ docId: id, token }, (payload) => {
      if (
        typeof payload !== "object" || payload === null ||
        !("title" in payload) || typeof payload.title !== "string" ||
        !("content" in payload) || typeof payload.content !== "string" ||
        !("updated_at" in payload) || typeof payload.updated_at !== "string" ||
        !Number.isFinite(Date.parse(payload.updated_at))
      ) return null;
      return { title: payload.title, content: payload.content, updated_at: payload.updated_at };
    }),
);

export async function fetchSharedMediaUrl(
  id: string,
  token: string,
  mediaUrl: string,
): Promise<SharedDocumentResult<string>> {
  return requestSharedDocument({ docId: id, mediaUrl, token }, (payload) => {
    if (typeof payload !== "object" || payload === null || !("signedUrl" in payload)) return null;
    return parseSignedUrl(payload.signedUrl);
  });
}

export async function resolveAppOrigin() {
  const headersList = await headers();
  return resolveAppOriginFromHeaders(headersList);
}

export async function fetchSharedMediaUrls(
  id: string,
  token: string,
  mediaUrls: string[],
): Promise<SharedDocumentResult<SharedMediaBatch>> {
  return requestSharedDocument({ docId: id, token, mediaUrls }, (payload) => {
    // Older deployments return a document rather than a batch. Keep the
    // existing browser fallback by reporting that response as unavailable.
    if (
      typeof payload !== "object" || payload === null ||
      !("urls" in payload) || !Array.isArray(payload.urls) ||
      !("expiresIn" in payload) || typeof payload.expiresIn !== "number" ||
      !Number.isFinite(payload.expiresIn) || payload.expiresIn <= 0 || payload.expiresIn > DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS
    ) return null;

    const requested = new Set(mediaUrls);
    const seen = new Set<string>();
    const urls: SharedMediaBatch["urls"] = [];
    for (const item of payload.urls) {
      if (
        typeof item !== "object" || item === null ||
        typeof item.mediaUrl !== "string" || !requested.has(item.mediaUrl) ||
        seen.has(item.mediaUrl) ||
        (item.signedUrl !== null && typeof item.signedUrl !== "string") ||
        (item.retry !== undefined && typeof item.retry !== "boolean")
      ) return null;
      seen.add(item.mediaUrl);
      const signedUrl = parseSignedUrl(item.signedUrl);
      urls.push({
        mediaUrl: item.mediaUrl,
        signedUrl,
        ...((item.retry === true || (item.signedUrl !== null && signedUrl === null))
          ? { retry: true }
          : {}),
      });
    }
    // An omitted entry is a broken response, not evidence that access was denied.
    if (seen.size !== requested.size) return null;
    return { urls, expiresIn: payload.expiresIn };
  });
}
