export const DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS = 5 * 60;

export type SharedDocumentMediaReference = {
  bucket: "document-images" | "document-videos";
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{64}$/;
const MEDIA_URL_CANDIDATE_PATTERN = /https?:\/\/[^\s<>"')]+|\/m\/[^\s<>"')]+/g;
const LEGACY_PUBLIC_PATH_PREFIXES = [
  "/storage/v1/object/public/",
  "/storage/v1/render/image/public/",
] as const;

function isDocumentMediaBucket(
  value: string,
): value is SharedDocumentMediaReference["bucket"] {
  return value === "document-images" || value === "document-videos";
}

function isSafePathSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function decodePathSegments(value: string) {
  const segments: string[] = [];

  for (const encodedSegment of value.split("/")) {
    let segment: string;

    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      return null;
    }

    if (!isSafePathSegment(segment)) {
      return null;
    }

    segments.push(segment);
  }

  return segments;
}

function encodePathSegments(segments: string[]) {
  if (segments.some((segment) => !isSafePathSegment(segment))) {
    throw new Error("Invalid shared document media path.");
  }

  return segments
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      )
    )
    .join("/");
}

function isExpectedSupabaseStorageOrigin(
  candidateUrl: URL,
  supabaseUrl: URL,
) {
  if (candidateUrl.origin === supabaseUrl.origin) {
    return true;
  }

  const projectHostMatch = supabaseUrl.hostname.match(
    /^([a-z0-9-]+)\.supabase\.co$/i,
  );
  return Boolean(
    projectHostMatch &&
      candidateUrl.protocol === "https:" &&
      candidateUrl.port === "" &&
      candidateUrl.hostname ===
        `${projectHostMatch[1]}.storage.supabase.co`,
  );
}

function parseCandidateSegments(
  value: string,
  supabaseUrlValue: string,
) {
  if (value.startsWith("/m/")) {
    let stableUrl: URL;

    try {
      stableUrl = new URL(value, "https://mushpot.invalid");
    } catch {
      return null;
    }

    return decodePathSegments(stableUrl.pathname.slice("/m/".length));
  }

  let candidateUrl: URL;
  let supabaseUrl: URL;

  try {
    candidateUrl = new URL(value);
    supabaseUrl = new URL(supabaseUrlValue);
  } catch {
    return null;
  }

  if (!isExpectedSupabaseStorageOrigin(candidateUrl, supabaseUrl)) {
    return null;
  }

  const prefix = LEGACY_PUBLIC_PATH_PREFIXES.find((candidatePrefix) =>
    candidateUrl.pathname.startsWith(candidatePrefix)
  );
  if (!prefix) {
    return null;
  }

  return decodePathSegments(candidateUrl.pathname.slice(prefix.length));
}

export function parseSharedDocumentMediaReference(
  value: string,
  {
    documentId,
    ownerId,
    supabaseUrl,
  }: ParseSharedDocumentMediaReferenceOptions,
): SharedDocumentMediaReference | null {
  if (!UUID_PATTERN.test(ownerId) || !UUID_PATTERN.test(documentId)) {
    return null;
  }

  const segments = parseCandidateSegments(value, supabaseUrl);
  if (!segments || segments.length < 4) {
    return null;
  }

  const [bucket, pathOwnerId, pathDocumentId, ...fileSegments] = segments;
  if (
    !isDocumentMediaBucket(bucket) ||
    pathOwnerId !== ownerId ||
    pathDocumentId !== documentId ||
    fileSegments.length === 0
  ) {
    return null;
  }

  return {
    bucket,
    path: [pathOwnerId, pathDocumentId, ...fileSegments].join("/"),
  };
}

export function buildSharedDocumentMediaUrl({
  documentId,
  reference,
  token,
}: BuildSharedDocumentMediaUrlOptions) {
  const pathSegments = reference.path.split("/");

  if (
    !UUID_PATTERN.test(documentId) ||
    !SHARE_TOKEN_PATTERN.test(token) ||
    !isDocumentMediaBucket(reference.bucket) ||
    pathSegments.length < 3 ||
    !UUID_PATTERN.test(pathSegments[0]) ||
    pathSegments[1] !== documentId
  ) {
    throw new Error("Invalid shared document media URL.");
  }

  return `/s/${documentId}/${token}/m/${reference.bucket}/${
    encodePathSegments(pathSegments)
  }`;
}

function getSharedDocumentMediaReferenceKey(
  reference: SharedDocumentMediaReference,
) {
  return `${reference.bucket}\0${reference.path}`;
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
