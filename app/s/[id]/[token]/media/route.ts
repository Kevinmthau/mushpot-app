import { NextResponse } from "next/server";

import {
  DOCUMENT_MEDIA_BATCH_MAX_URLS,
  DOCUMENT_MEDIA_MAX_URL_LENGTH,
} from "@/lib/document-media";
import { fetchSharedMediaUrls } from "@/lib/shared-document";

export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function POST(request: Request, context: {
  params: Promise<{ id: string; token: string }>;
}) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, {
      status: 400,
      headers,
    });
  }
  if (
    typeof body !== "object" || body === null || !("mediaUrls" in body) ||
    !Array.isArray(body.mediaUrls) || body.mediaUrls.length === 0 ||
    body.mediaUrls.length > DOCUMENT_MEDIA_BATCH_MAX_URLS ||
    body.mediaUrls.some((url) => typeof url !== "string" || url.length > DOCUMENT_MEDIA_MAX_URL_LENGTH)
  ) {
    return NextResponse.json({ error: "Invalid media batch." }, {
      status: 400,
      headers,
    });
  }
  const { id, token } = await context.params;
  try {
    const result = await fetchSharedMediaUrls(id, token, body.mediaUrls);
    if (result.status === "success") return NextResponse.json(result.data, { headers });
    if (result.status === "not_found") {
      // Preserve the browser's denial contract for revoked shares.
      return NextResponse.json({ urls: [], expiresIn: 0 }, { headers });
    }
  } catch (error) {
    console.error("[shared-document-media] batch signing failed", error);
  }
  return NextResponse.json({ error: "Batch signing unavailable." }, {
    status: 503,
    headers: { ...headers, "Retry-After": "30" },
  });
}
