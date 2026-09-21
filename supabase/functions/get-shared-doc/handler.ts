import {
  DOCUMENT_MEDIA_BATCH_MAX_URLS,
  DOCUMENT_MEDIA_MAX_URL_LENGTH,
  isUuid,
  type SharedMediaBatchResponse,
} from "../_shared/document-media-core.ts";
import { getCorsHeaders, isCorsOriginAllowed } from "../_shared/cors.ts";
import {
  buildSharedDocumentMediaUrl,
  DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS,
  getSharedDocumentMediaReferences,
  hasSharedDocumentMediaReference,
  parseSharedDocumentMediaReference,
  rewriteSharedDocumentMediaUrls,
  sharedDocumentContentReferencesMedia,
  type SharedDocumentMediaReference,
} from "../_shared/document-media.ts";

type SharedDocPayload = {
  docId: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  token: string;
};

export type SharedDocumentRow = {
  owner: string;
  title: string;
  content: string;
  updated_at: string;
};

type QueryResult<T> = {
  data: T | null;
  error: unknown;
};

export type SharedDocumentOperations = {
  createSignedUrls: (
    bucket: SharedDocumentMediaReference["bucket"],
    paths: string[],
    expiresIn: number,
  ) => Promise<
    QueryResult<
      Array<
        { path: string | null; signedUrl: string | null; error: string | null }
      >
    >
  >;
  createSignedUrl: (
    bucket: SharedDocumentMediaReference["bucket"],
    path: string,
    expiresIn: number,
  ) => Promise<QueryResult<{ signedUrl: string }>>;
  getSharedDocument: (
    docId: string,
    token: string,
  ) => Promise<QueryResult<SharedDocumentRow>>;
};

type SharedDocumentRequestDependencies = {
  createOperations: (
    supabaseUrl: string,
    serviceRoleKey: string,
  ) => SharedDocumentOperations;
  getEnvironmentValue: (name: string) => string | undefined;
};

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

export async function handleSharedDocumentRequest(
  request: Request,
  {
    createOperations,
    getEnvironmentValue,
  }: SharedDocumentRequestDependencies,
) {
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

  const supabaseUrl = getEnvironmentValue("SUPABASE_URL");
  const serviceRoleKey = getEnvironmentValue("SUPABASE_SERVICE_ROLE_KEY");

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

  const body = typeof payload === "object" && payload !== null
    ? (payload as Partial<SharedDocPayload>)
    : {};
  const docId = typeof body.docId === "string" ? body.docId : "";
  const token = typeof body.token === "string" ? body.token : "";
  const mediaUrl = body.mediaUrl;
  const mediaUrls = body.mediaUrls;

  if (
    !isUuid(docId) ||
    !SHARE_TOKEN_PATTERN.test(token) ||
    (mediaUrl !== undefined && typeof mediaUrl !== "string") ||
    (mediaUrls !== undefined && (
      mediaUrl !== undefined || !Array.isArray(mediaUrls) ||
      mediaUrls.length === 0 ||
      mediaUrls.length > DOCUMENT_MEDIA_BATCH_MAX_URLS ||
      mediaUrls.some((url) =>
        typeof url !== "string" || url.length > DOCUMENT_MEDIA_MAX_URL_LENGTH
      )
    ))
  ) {
    return jsonResponse(request, { error: "Invalid share link." }, 400);
  }

  const operations = createOperations(supabaseUrl, serviceRoleKey);
  let lookup: Awaited<
    ReturnType<SharedDocumentOperations["getSharedDocument"]>
  >;
  try {
    lookup = await operations.getSharedDocument(docId, token);
  } catch {
    return jsonResponse(request, {
      error: "Shared document temporarily unavailable.",
    }, 503);
  }
  const { data, error } = lookup;
  if (error) {
    return jsonResponse(request, {
      error: "Shared document temporarily unavailable.",
    }, 503);
  }

  if (!data) {
    return jsonResponse(
      request,
      { error: "Invalid or expired share link." },
      404,
    );
  }

  if (mediaUrls !== undefined) {
    const options = { documentId: docId, ownerId: data.owner, supabaseUrl };
    const references = getSharedDocumentMediaReferences(data.content, options);
    const results = new Map<
      string,
      { signedUrl: string | null; retry: boolean }
    >();
    const buckets = new Map<
      SharedDocumentMediaReference["bucket"],
      Map<string, string[]>
    >();
    for (const url of new Set(mediaUrls)) {
      results.set(url, { signedUrl: null, retry: false });
      const reference = parseSharedDocumentMediaReference(url, options);
      if (
        !reference || !hasSharedDocumentMediaReference(references, reference)
      ) continue;
      // Authorized media can retry through the single route if Storage has a
      // partial outage. Denied references must not trigger additional requests.
      results.set(url, { signedUrl: null, retry: true });
      const paths = buckets.get(reference.bucket) ??
        new Map<string, string[]>();
      paths.set(reference.path, [...(paths.get(reference.path) ?? []), url]);
      buckets.set(reference.bucket, paths);
    }
    await Promise.all(Array.from(buckets, async ([bucket, paths]) => {
      try {
        const signed = await operations.createSignedUrls(
          bucket,
          Array.from(paths.keys()),
          DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS,
        );
        if (signed.error) return;
        for (const result of signed.data ?? []) {
          if (!result.path || result.error || !result.signedUrl) continue;
          for (const url of paths.get(result.path) ?? []) {
            results.set(url, { signedUrl: result.signedUrl, retry: false });
          }
        }
      } catch {
        // One unavailable bucket must not prevent the remaining media loading.
      }
    }));
    return jsonResponse(
      request,
      {
        urls: Array.from(
          results,
          ([mediaUrl, result]) => ({ mediaUrl, ...result }),
        ),
        expiresIn: DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS,
      } satisfies SharedMediaBatchResponse,
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

    try {
      const { data: signedData, error: signedError } = await operations
        .createSignedUrl(
          media.bucket,
          media.path,
          DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS,
        );

      if (!signedError && signedData?.signedUrl) {
        return jsonResponse(request, { signedUrl: signedData.signedUrl });
      }
    } catch {
      // Authorization already succeeded. A signing outage is retryable and
      // must not be reported as a denied reference or expose signed URLs.
    }

    return jsonResponse(request, {
      error: "Shared document media temporarily unavailable.",
    }, 503);
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
}
