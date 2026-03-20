import { cache } from "react";
import { headers } from "next/headers";

export type SharedDocument = {
  title: string;
  content: string;
  updated_at: string;
};

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const DEFAULT_SHARED_DOCUMENT_DESCRIPTION = "Open this shared document in Mushpot.";

function stripTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
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

function buildRequestOriginFromHeaders(
  headersList: {
    get(name: string): string | null;
  },
  isLocalhost: boolean,
) {
  const forwardedHost = headersList.get("x-forwarded-host");
  const host = (forwardedHost ?? headersList.get("host") ?? "").split(",")[0]?.trim();

  if (!host) {
    return null;
  }

  const forwardedProto = headersList.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || (isLocalhost ? "http" : "https");

  return `${protocol}://${host}`;
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
  async (id: string, token: string): Promise<SharedDocument | null> => {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error(
        "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
      );
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/get-shared-doc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ docId: id, token }),
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as SharedDocument;
  },
);

export async function resolveAppOrigin() {
  const configuredAppUrl = stripTrailingSlashes(process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "");
  const headersList = await headers();
  const host = (headersList.get("x-forwarded-host") ?? headersList.get("host") ?? "")
    .split(",")[0]
    ?.trim();
  const hostname = host?.split(":")[0]?.toLowerCase() ?? "";
  const isLocalhost = LOCALHOST_HOSTNAMES.has(hostname);
  const requestOrigin = buildRequestOriginFromHeaders(headersList, isLocalhost);

  return isLocalhost && configuredAppUrl ? configuredAppUrl : requestOrigin ?? configuredAppUrl;
}
