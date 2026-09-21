import {
  buildDocumentMediaUrl,
  type DocumentMediaBucket,
  isDocumentMediaBucket,
  isUuid,
  MEDIA_URL_CANDIDATE_PATTERN,
  parseDocumentMediaUrl,
} from "./document-media-core.ts";

export { DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS } from "./document-media-core.ts";

export type SharedDocumentMediaReference = {
  bucket: DocumentMediaBucket;
  path: string;
};

type ParseSharedDocumentMediaReferenceOptions = {
  documentId: string;
  ownerId: string;
  supabaseUrl: string;
};

type RewriteSharedDocumentMediaOptions =
  & ParseSharedDocumentMediaReferenceOptions
  & {
    resolve: (
      reference: SharedDocumentMediaReference,
    ) => Promise<string> | string;
  };

type BuildSharedDocumentMediaUrlOptions = {
  documentId: string;
  reference: SharedDocumentMediaReference;
  token: string;
};

const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{64}$/;

export function parseSharedDocumentMediaReference(
  value: string,
  {
    documentId,
    ownerId,
    supabaseUrl,
  }: ParseSharedDocumentMediaReferenceOptions,
): SharedDocumentMediaReference | null {
  const media = parseDocumentMediaUrl(value, supabaseUrl);
  // Sharing authorizes exact owner/document paths; legacy backfill rules must
  // never relax this comparison or authorize a different document's object.
  if (!media || media.ownerId !== ownerId || media.documentId !== documentId) {
    return null;
  }
  return { bucket: media.bucket, path: media.storagePath };
}

export function buildSharedDocumentMediaUrl({
  documentId,
  reference,
  token,
}: BuildSharedDocumentMediaUrlOptions) {
  const pathSegments = reference.path.split("/");

  if (
    !isUuid(documentId) ||
    !SHARE_TOKEN_PATTERN.test(token) ||
    !isDocumentMediaBucket(reference.bucket) ||
    pathSegments.length < 3 ||
    !isUuid(pathSegments[0]) ||
    pathSegments[1] !== documentId
  ) {
    throw new Error("Invalid shared document media URL.");
  }

  try {
    return `/s/${documentId}/${token}${
      buildDocumentMediaUrl(reference.bucket, reference.path)
    }`;
  } catch {
    throw new Error("Invalid shared document media path.");
  }
}

function getSharedDocumentMediaReferenceKey(
  reference: SharedDocumentMediaReference,
) {
  return `${reference.bucket}\0${reference.path}`;
}

export function getSharedDocumentMediaReferences(
  content: string,
  options: ParseSharedDocumentMediaReferenceOptions,
) {
  const references = new Map<string, SharedDocumentMediaReference>();
  for (const match of content.matchAll(MEDIA_URL_CANDIDATE_PATTERN)) {
    const reference = parseSharedDocumentMediaReference(match[0], options);
    if (reference) {
      references.set(getSharedDocumentMediaReferenceKey(reference), reference);
    }
  }
  return references;
}

export function hasSharedDocumentMediaReference(
  references: Map<string, SharedDocumentMediaReference>,
  reference: SharedDocumentMediaReference,
) {
  return references.has(getSharedDocumentMediaReferenceKey(reference));
}

export function sharedDocumentContentReferencesMedia(
  content: string,
  expectedReference: SharedDocumentMediaReference,
  options: ParseSharedDocumentMediaReferenceOptions,
) {
  const expectedKey = getSharedDocumentMediaReferenceKey(expectedReference);

  for (const match of content.matchAll(MEDIA_URL_CANDIDATE_PATTERN)) {
    const reference = parseSharedDocumentMediaReference(match[0], options);

    if (
      reference &&
      getSharedDocumentMediaReferenceKey(reference) === expectedKey
    ) {
      return true;
    }
  }

  return false;
}

export async function rewriteSharedDocumentMediaUrls(
  content: string,
  options: RewriteSharedDocumentMediaOptions,
) {
  const candidates: Array<{
    end: number;
    key: string;
    start: number;
  }> = [];
  const references = new Map<string, SharedDocumentMediaReference>();

  for (const match of content.matchAll(MEDIA_URL_CANDIDATE_PATTERN)) {
    const value = match[0];
    const reference = parseSharedDocumentMediaReference(value, options);
    const start = match.index;

    if (!reference || start === undefined) {
      continue;
    }

    const key = getSharedDocumentMediaReferenceKey(reference);
    references.set(key, reference);
    candidates.push({
      end: start + value.length,
      key,
      start,
    });
  }

  if (candidates.length === 0) {
    return content;
  }

  const resolvedUrls = new Map<string, string>();
  await Promise.all(
    Array.from(references, async ([key, reference]) => {
      try {
        const resolvedUrl = await options.resolve(reference);
        if (resolvedUrl) {
          resolvedUrls.set(key, resolvedUrl);
        }
      } catch {
        // A missing or malformed object should only affect that embed. Keep
        // the original URL so the rest of the shared document remains usable.
      }
    }),
  );

  let rewrittenContent = content;
  for (const candidate of candidates.reverse()) {
    const resolvedUrl = resolvedUrls.get(candidate.key);
    if (!resolvedUrl) {
      continue;
    }

    rewrittenContent = rewrittenContent.slice(0, candidate.start) +
      resolvedUrl +
      rewrittenContent.slice(candidate.end);
  }

  return rewrittenContent;
}
