import { createClient } from "npm:@supabase/supabase-js@2.110.7";

import {
  getCorsHeaders,
  isCorsOriginAllowed,
} from "../_shared/cors.ts";
import {
  buildSharedDocumentMediaUrl,
  DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS,
  parseSharedDocumentMediaReference,
  rewriteSharedDocumentMediaUrls,
  sharedDocumentContentReferencesMedia,
} from "../_shared/document-media.ts";

type SharedDocPayload = {
  docId: string;
  mediaUrl?: string;
  token: string;
};

type DocumentRow = {
  owner: string;
  title: string;
  content: string;
  updated_at: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{64}$/;

function jsonResponse(
  request: Request,
  body: Record<string, unknown>,
  status = 200,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(request),
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (request) => {
  if (!isCorsOriginAllowed(request)) {
    return jsonResponse(request, { error: "Origin not allowed." }, 403);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...getCorsHeaders(request),
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      request,
      { error: "Missing Supabase environment variables." },
      500,
    );
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse(request, { error: "Invalid JSON body." }, 400);
  }

  const body =
    typeof payload === "object" && payload !== null
      ? (payload as Partial<SharedDocPayload>)
      : {};
  const docId = typeof body.docId === "string" ? body.docId : "";
  const token = typeof body.token === "string" ? body.token : "";
  const mediaUrl = body.mediaUrl;

  if (
    !UUID_PATTERN.test(docId) ||
    !SHARE_TOKEN_PATTERN.test(token) ||
    (mediaUrl !== undefined && typeof mediaUrl !== "string")
  ) {
    return jsonResponse(request, { error: "Invalid share link." }, 400);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await adminClient
    .from("documents")
    .select("owner, title, content, updated_at")
    .eq("id", docId)
    .eq("share_enabled", true)
    .eq("share_token", token)
    .maybeSingle<DocumentRow>();

  if (error || !data) {
    return jsonResponse(
      request,
      { error: "Invalid or expired share link." },
      404,
    );
  }

  if (mediaUrl !== undefined) {
    const media = parseSharedDocumentMediaReference(mediaUrl, {
      documentId: docId,
      ownerId: data.owner,
      supabaseUrl,
    });

    if (
      !media ||
      !sharedDocumentContentReferencesMedia(data.content, media, {
        documentId: docId,
        ownerId: data.owner,
        supabaseUrl,
      })
    ) {
      return jsonResponse(request, { error: "Media not found." }, 404);
    }

    const { data: signedData, error: signedError } = await adminClient.storage
      .from(media.bucket)
      .createSignedUrl(media.path, DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS);

    if (signedError || !signedData?.signedUrl) {
      if (signedError) {
        console.error("Unable to sign shared document media", signedError);
      }
      return jsonResponse(request, { error: "Media not found." }, 404);
    }

    return jsonResponse(request, { signedUrl: signedData.signedUrl });
  }

  const content = await rewriteSharedDocumentMediaUrls(data.content, {
    documentId: docId,
    ownerId: data.owner,
    supabaseUrl,
    resolve: (reference) =>
      buildSharedDocumentMediaUrl({
        documentId: docId,
        reference,
        token,
      }),
  });

  return jsonResponse(request, {
    title: data.title,
    content,
    updated_at: data.updated_at,
  });
});
