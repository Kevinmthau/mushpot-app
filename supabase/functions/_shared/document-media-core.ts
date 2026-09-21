// Runtime-neutral media syntax and protocol shared by Next.js and Deno.
export const DOCUMENT_IMAGE_BUCKET = "document-images";
export const DOCUMENT_VIDEO_BUCKET = "document-videos";

export const DOCUMENT_MEDIA_BUCKETS = [
  DOCUMENT_IMAGE_BUCKET,
  DOCUMENT_VIDEO_BUCKET,
] as const;

export type DocumentMediaBucket = (typeof DOCUMENT_MEDIA_BUCKETS)[number];

export const DOCUMENT_MEDIA_BATCH_MAX_URLS = 50;
export const DOCUMENT_MEDIA_MAX_URL_LENGTH = 4096;
export const DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS = 300;

export type SharedMediaUrlResult = {
  mediaUrl: string;
  signedUrl: string | null;
  retry?: boolean;
};

export type SharedMediaBatchResponse = {
  urls: SharedMediaUrlResult[];
  expiresIn: number;
};

export const MEDIA_URL_CANDIDATE_PATTERN =
  /https?:\/\/[^\s<>"')]+|\/m\/[^\s<>"')]+/g;

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

export function encodeDocumentMediaPath(path: string) {
  const segments = path.split("/");

  if (segments.some((segment) => !isSafeStoragePathSegment(segment))) {
    throw new Error("Invalid document media path.");
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

export function buildDocumentMediaUrl(
  bucket: DocumentMediaBucket,
  storagePath: string,
) {
  return `/m/${bucket}/${encodeDocumentMediaPath(storagePath)}`;
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

export function isConfiguredSupabaseStorageOrigin(
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

// Classification lets migration tools block malformed owned URLs while ignoring
// external images. Parsing alone does not authorize access to the stored object.
export type DocumentMediaCandidate =
  | { status: "media"; media: DocumentMediaRoute }
  | { status: "unrelated" }
  | { status: "invalid"; reason: "local-url" | "url" | "path" };

export function parseDocumentMediaCandidate(
  value: string,
  supabaseUrlValue?: string,
): DocumentMediaCandidate {
  let encodedPath: string;
  if (value.startsWith("/m/")) {
    try {
      const stableUrl = new URL(value, "https://mushpot.invalid");
      encodedPath = stableUrl.pathname.slice("/m/".length);
    } catch {
      return { status: "invalid", reason: "local-url" };
    }
  } else {
    if (!supabaseUrlValue) return { status: "unrelated" };
    let candidateUrl: URL;
    let supabaseUrl: URL;
    try {
      candidateUrl = new URL(value);
      supabaseUrl = new URL(supabaseUrlValue);
    } catch {
      return { status: "unrelated" };
    }
    if (!isConfiguredSupabaseStorageOrigin(candidateUrl, supabaseUrl)) {
      return { status: "unrelated" };
    }
    const prefix = PUBLIC_STORAGE_PATH_PREFIXES.find((item) =>
      candidateUrl.pathname.startsWith(item)
    );
    if (!prefix) return { status: "unrelated" };
    encodedPath = candidateUrl.pathname.slice(prefix.length);
  }

  const segments = decodeStoragePathSegments(encodedPath);
  if (!segments || segments.length < 4 || !isDocumentMediaBucket(segments[0])) {
    return { status: "invalid", reason: "url" };
  }
  const [bucket, ...path] = segments;
  const media = parseDocumentMediaRoute(bucket, path);
  return media
    ? { status: "media", media }
    : { status: "invalid", reason: "path" };
}

export function parseDocumentMediaUrl(
  value: string,
  supabaseUrl?: string,
): DocumentMediaRoute | null {
  const candidate = parseDocumentMediaCandidate(value, supabaseUrl);
  return candidate.status === "media" ? candidate.media : null;
}

export function normalizeDocumentMediaUrl(value: string, supabaseUrl?: string) {
  // Preserve stable URL query strings/fragments and malformed legacy content;
  // callers that authorize an object must use the validating parser instead.
  if (value.startsWith("/m/")) return value;
  const media = parseDocumentMediaUrl(value, supabaseUrl);
  return media ? buildDocumentMediaUrl(media.bucket, media.storagePath) : value;
}
