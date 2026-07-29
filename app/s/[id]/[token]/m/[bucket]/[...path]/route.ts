import { NextResponse } from "next/server";

import {
  buildDocumentMediaUrl,
  parseDocumentMediaRoute,
} from "@/lib/document-media";
import { fetchSharedMediaUrl } from "@/lib/shared-document";

export const dynamic = "force-dynamic";

const MEDIA_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

type SharedMediaRouteContext = {
  params: Promise<{
    bucket: string;
    id: string;
    path: string[];
    token: string;
  }>;
};

function textResponse(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: MEDIA_RESPONSE_HEADERS,
  });
}

export async function GET(
  _request: Request,
  context: SharedMediaRouteContext,
) {
  const { bucket, id, path, token } = await context.params;
  const media = parseDocumentMediaRoute(bucket, path);

  if (!media) {
    return textResponse("Invalid media path.", 400);
  }

  if (media.documentId !== id) {
    return textResponse("Media not found.", 404);
  }

  let signedUrlValue: string | null;

  try {
    signedUrlValue = await fetchSharedMediaUrl(
      id,
      token,
      buildDocumentMediaUrl(media.bucket, media.storagePath),
    );
  } catch (error) {
    console.error("[shared-document-media] signing request failed", error);
    return textResponse("Unable to load media.", 500);
  }

  if (!signedUrlValue) {
    return textResponse("Media not found.", 404);
  }

  let signedUrl: URL;
  let supabaseOrigin: string;

  try {
    signedUrl = new URL(signedUrlValue);
    supabaseOrigin = new URL(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    ).origin;
  } catch {
    return textResponse("Unable to load media.", 500);
  }

  if (signedUrl.origin !== supabaseOrigin) {
    console.error(
      "[shared-document-media] refused an unexpected signed URL origin",
    );
    return textResponse("Unable to load media.", 500);
  }

  return NextResponse.redirect(signedUrl, {
    status: 307,
    headers: MEDIA_RESPONSE_HEADERS,
  });
}
