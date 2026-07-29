import { NextResponse } from "next/server";

import { parseDocumentMediaRoute } from "@/lib/document-media";
import { queryWithCloneStatusFallback } from "@/lib/supabase/clone-status-compat";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SIGNED_MEDIA_URL_TTL_SECONDS = 5 * 60;
const MEDIA_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

type MediaRouteContext = {
  params: Promise<{
    bucket: string;
    path: string[];
  }>;
};

function textResponse(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: MEDIA_RESPONSE_HEADERS,
  });
}

export async function GET(_request: Request, context: MediaRouteContext) {
  const { bucket, path } = await context.params;
  const media = parseDocumentMediaRoute(bucket, path);

  if (!media) {
    return textResponse("Invalid media path.", 400);
  }

  const supabase = await createSupabaseServerClient();
  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();
  const userId = claimsData?.claims.sub;

  if (claimsError || typeof userId !== "string") {
    return textResponse("Authentication required.", 401);
  }

  if (media.ownerId !== userId) {
    return textResponse("Not authorized.", 403);
  }

  const { data: sourceDocument, error: sourceDocumentError } =
    await queryWithCloneStatusFallback(
      () =>
        supabase
          .from("documents")
          .select("id")
          .eq("id", media.documentId)
          .eq("owner", userId)
          .is("clone_status", null)
          .maybeSingle(),
      () =>
        supabase
          .from("documents")
          .select("id")
          .eq("id", media.documentId)
          .eq("owner", userId)
          .maybeSingle(),
    );

  if (sourceDocumentError || !sourceDocument) {
    if (sourceDocumentError) {
      console.error(
        "[document-media] source document lookup failed",
        sourceDocumentError,
      );
    }
    return textResponse("Media not found.", 404);
  }

  const { data: signedData, error: signedUrlError } = await supabase.storage
    .from(media.bucket)
    .createSignedUrl(media.storagePath, SIGNED_MEDIA_URL_TTL_SECONDS);

  if (signedUrlError || !signedData?.signedUrl) {
    if (signedUrlError) {
      console.error("[document-media] signing failed", signedUrlError);
    }
    return textResponse("Media not found.", 404);
  }

  let signedUrl: URL;
  let supabaseOrigin: string;

  try {
    signedUrl = new URL(signedData.signedUrl);
    supabaseOrigin = new URL(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    ).origin;
  } catch {
    return textResponse("Unable to load media.", 500);
  }

  if (signedUrl.origin !== supabaseOrigin) {
    console.error("[document-media] refused an unexpected signed URL origin");
    return textResponse("Unable to load media.", 500);
  }

  return NextResponse.redirect(signedUrl, {
    status: 307,
    headers: MEDIA_RESPONSE_HEADERS,
  });
}
