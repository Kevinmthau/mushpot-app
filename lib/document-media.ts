export const DOCUMENT_IMAGE_BUCKET = "document-images";
export const DOCUMENT_VIDEO_BUCKET = "document-videos";

export type DocumentMediaBucket =
  | typeof DOCUMENT_IMAGE_BUCKET
  | typeof DOCUMENT_VIDEO_BUCKET;

export type DocumentMediaRoute = {
  bucket: DocumentMediaBucket;
  documentId: string;
  ownerId: string;
  storagePath: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_STORAGE_PATH_PREFIXES = [
  "/storage/v1/object/public/",
  "/storage/v1/render/image/public/",
] as const;
const MEDIA_URL_CANDIDATE_PATTERN =
  /https?:\/\/[^\s<>"')]+|\/m\/[^\s<>"')]+/g;

export function isDocumentMediaBucket(
  value: string,
): value is DocumentMediaBucket {
  return value === DOCUMENT_IMAGE_BUCKET || value === DOCUMENT_VIDEO_BUCKET;
}

export function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function isSafeStoragePathSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function decodeStoragePathSegments(pathname: string) {
  const encodedSegments = pathname.split("/");
  const decodedSegments: string[] = [];

  for (const segment of encodedSegments) {
    let decodedSegment: string;

    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      return null;
    }

    if (!isSafeStoragePathSegment(decodedSegment)) {
      return null;
    }

    decodedSegments.push(decodedSegment);
  }

  return decodedSegments;
}

function encodeStoragePath(path: string) {
  const segments = path.split("/");

  if (segments.some((segment) => !isSafeStoragePathSegment(segment))) {
    throw new Error("Invalid document media path.");
  }

  return segments
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

export function buildDocumentMediaUrl(
  bucket: DocumentMediaBucket,
  storagePath: string,
) {
  return `/m/${bucket}/${encodeStoragePath(storagePath)}`;
}

export function parseDocumentMediaRoute(
  bucketValue: string,
  pathSegments: string[],
): DocumentMediaRoute | null {
  if (
    !isDocumentMediaBucket(bucketValue) ||
    pathSegments.length < 3 ||
    pathSegments.some((segment) => !isSafeStoragePathSegment(segment))
  ) {
    return null;
  }

  const [ownerId, documentId] = pathSegments;
  if (!isUuid(ownerId) || !isUuid(documentId)) {
    return null;
  }

  return {
    bucket: bucketValue,
    documentId,
    ownerId,
    storagePath: pathSegments.join("/"),
  };
}

function isConfiguredSupabaseStorageOrigin(
  candidateUrl: URL,
  supabaseUrl: URL,
) {
  if (candidateUrl.origin === supabaseUrl.origin) {
    return true;
  }

  const match = supabaseUrl.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
  return Boolean(
    match &&
      candidateUrl.protocol === "https:" &&
      candidateUrl.port === "" &&
      candidateUrl.hostname === `${match[1]}.storage.supabase.co`,
  );
}

function parseLegacyPublicMediaUrl(value: string, supabaseUrlValue: string) {
  let candidateUrl: URL;
  let supabaseUrl: URL;

  try {
    candidateUrl = new URL(value);
    supabaseUrl = new URL(supabaseUrlValue);
  } catch {
    return null;
  }

  if (!isConfiguredSupabaseStorageOrigin(candidateUrl, supabaseUrl)) {
    return null;
  }

  const prefix = PUBLIC_STORAGE_PATH_PREFIXES.find((candidatePrefix) =>
    candidateUrl.pathname.startsWith(candidatePrefix),
  );
  if (!prefix) {
    return null;
  }

  const segments = decodeStoragePathSegments(
    candidateUrl.pathname.slice(prefix.length),
  );
  if (!segments || segments.length < 4) {
    return null;
  }

  const [bucket, ...pathSegments] = segments;
  return parseDocumentMediaRoute(bucket, pathSegments);
}

export function parseDocumentMediaUrl(
  value: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
): DocumentMediaRoute | null {
  if (value.startsWith("/m/")) {
    let candidateUrl: URL;

    try {
      candidateUrl = new URL(value, "https://mushpot.invalid");
    } catch {
      return null;
    }

    const segments = decodeStoragePathSegments(
      candidateUrl.pathname.slice("/m/".length),
    );
    if (!segments || segments.length < 4) {
      return null;
    }

    const [bucket, ...pathSegments] = segments;
    return parseDocumentMediaRoute(bucket, pathSegments);
  }

  if (!supabaseUrl) {
    return null;
  }

  return parseLegacyPublicMediaUrl(value, supabaseUrl);
}

export function documentContentReferencesMediaFromDocument(
  content: string,
  ownerId: string,
  documentId: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
) {
  if (!isUuid(ownerId) || !isUuid(documentId)) {
    return false;
  }

  for (const match of content.matchAll(MEDIA_URL_CANDIDATE_PATTERN)) {
    const media = parseDocumentMediaUrl(match[0], supabaseUrl);

    if (media?.ownerId === ownerId && media.documentId === documentId) {
      return true;
    }
  }

  return false;
}

export function normalizeDocumentMediaUrl(
  value: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
) {
  if (value.startsWith("/m/")) {
    return value;
  }

  if (!supabaseUrl) {
    return value;
  }

  const media = parseLegacyPublicMediaUrl(value, supabaseUrl);
  return media ? buildDocumentMediaUrl(media.bucket, media.storagePath) : value;
}
