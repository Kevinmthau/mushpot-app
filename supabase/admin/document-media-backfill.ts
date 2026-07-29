export const DOCUMENT_MEDIA_BUCKETS = [
  "document-images",
  "document-videos",
] as const;

export type DocumentMediaBucket = (typeof DOCUMENT_MEDIA_BUCKETS)[number];

export type MediaReference = {
  bucket: DocumentMediaBucket;
  originalUrl: string;
  path: string;
};

export type MediaCopy = {
  bucket: DocumentMediaBucket;
  destinationPath: string;
  sourcePath: string;
};

export type BackfillAnalysis = {
  blockers: string[];
  copies: MediaCopy[];
  references: MediaReference[];
  rewrittenContent: string;
};

type AnalyzeOptions = {
  content: string;
  documentId: string;
  ownerId: string;
  supabaseUrl: string;
};

type ParsedCandidate = MediaReference & {
  documentId: string;
  fileSegments: string[];
  ownerId: string;
};

type Occurrence = {
  end: number;
  replacement: string;
  start: number;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_URL_CANDIDATE_PATTERN = /https?:\/\/[^\s<>"')]+|\/m\/[^\s<>"')]+/g;
const LEGACY_PUBLIC_PATH_PREFIXES = [
  "/storage/v1/object/public/",
  "/storage/v1/render/image/public/",
] as const;

function isBucket(value: string): value is DocumentMediaBucket {
  return DOCUMENT_MEDIA_BUCKETS.includes(value as DocumentMediaBucket);
}

function isSafeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function decodeSegments(value: string) {
  const decoded: string[] = [];

  for (const encoded of value.split("/")) {
    try {
      const segment = decodeURIComponent(encoded);
      if (!isSafeSegment(segment)) {
        return null;
      }
      decoded.push(segment);
    } catch {
      return null;
    }
  }

  return decoded;
}

function encodeSegments(segments: string[]) {
  return segments
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      )
    )
    .join("/");
}

function isExpectedStorageOrigin(candidate: URL, supabase: URL) {
  if (candidate.origin === supabase.origin) {
    return true;
  }

  const projectHost = supabase.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
  return Boolean(
    projectHost &&
      candidate.protocol === "https:" &&
      candidate.port === "" &&
      candidate.hostname === `${projectHost[1]}.storage.supabase.co`,
  );
}

function parseCandidate(
  value: string,
  supabaseUrlValue: string,
): { blocker?: string; media?: ParsedCandidate; related: boolean } {
  let segments: string[] | null = null;

  if (value.startsWith("/m/")) {
    let stableUrl: URL;
    try {
      stableUrl = new URL(value, "https://mushpot.invalid");
    } catch {
      return {
        blocker: `Malformed local media URL: ${value}`,
        related: true,
      };
    }
    segments = decodeSegments(stableUrl.pathname.slice("/m/".length));
  } else {
    let candidateUrl: URL;
    let supabaseUrl: URL;
    try {
      candidateUrl = new URL(value);
      supabaseUrl = new URL(supabaseUrlValue);
    } catch {
      return { related: false };
    }

    if (!isExpectedStorageOrigin(candidateUrl, supabaseUrl)) {
      return { related: false };
    }

    const prefix = LEGACY_PUBLIC_PATH_PREFIXES.find((item) =>
      candidateUrl.pathname.startsWith(item)
    );
    if (!prefix) {
      return { related: false };
    }
    segments = decodeSegments(candidateUrl.pathname.slice(prefix.length));
  }

  if (!segments || segments.length < 4 || !isBucket(segments[0])) {
    return {
      blocker: `Malformed document media URL: ${value}`,
      related: true,
    };
  }

  const [bucket, ownerId, documentId, ...fileSegments] = segments;
  if (
    !UUID_PATTERN.test(ownerId) ||
    !UUID_PATTERN.test(documentId) ||
    fileSegments.length === 0
  ) {
    return {
      blocker: `Malformed document media path: ${value}`,
      related: true,
    };
  }

  return {
    media: {
      bucket,
      documentId: documentId.toLowerCase(),
      fileSegments,
      originalUrl: value,
      ownerId: ownerId.toLowerCase(),
      path: [ownerId, documentId, ...fileSegments].join("/"),
    },
    related: true,
  };
}

function stableMediaUrl(bucket: DocumentMediaBucket, path: string) {
  return `/m/${bucket}/${encodeSegments(path.split("/"))}`;
}

export function analyzeDocumentMedia({
  content,
  documentId,
  ownerId,
  supabaseUrl,
}: AnalyzeOptions): BackfillAnalysis {
  const normalizedDocumentId = documentId.toLowerCase();
  const normalizedOwnerId = ownerId.toLowerCase();
  const blockers: string[] = [];
  const copiesBySource = new Map<string, MediaCopy>();
  const occurrences: Occurrence[] = [];
  const referencesByKey = new Map<string, MediaReference>();

  for (const match of content.matchAll(MEDIA_URL_CANDIDATE_PATTERN)) {
    const start = match.index;
    if (start === undefined) {
      continue;
    }

    const parsed = parseCandidate(match[0], supabaseUrl);
    if (!parsed.related) {
      continue;
    }
    if (parsed.blocker || !parsed.media) {
      blockers.push(parsed.blocker ?? `Malformed media URL: ${match[0]}`);
      continue;
    }

    const media = parsed.media;
    if (media.ownerId !== normalizedOwnerId) {
      blockers.push(
        `Cross-owner media reference is not allowed: ${media.originalUrl}`,
      );
      continue;
    }

    referencesByKey.set(`${media.bucket}\0${media.path}`, {
      bucket: media.bucket,
      originalUrl: media.originalUrl,
      path: media.path,
    });

    let destinationPath = media.path;
    if (media.documentId !== normalizedDocumentId) {
      destinationPath = [
        normalizedOwnerId,
        normalizedDocumentId,
        media.documentId,
        ...media.fileSegments,
      ].join("/");
      copiesBySource.set(`${media.bucket}\0${media.path}`, {
        bucket: media.bucket,
        destinationPath,
        sourcePath: media.path,
      });
    }

    occurrences.push({
      end: start + match[0].length,
      replacement: stableMediaUrl(media.bucket, destinationPath),
      start,
    });
  }

  let rewrittenContent = content;
  for (const occurrence of occurrences.reverse()) {
    rewrittenContent = rewrittenContent.slice(0, occurrence.start) +
      occurrence.replacement +
      rewrittenContent.slice(occurrence.end);
  }

  return {
    blockers,
    copies: Array.from(copiesBySource.values()),
    references: Array.from(referencesByKey.values()),
    rewrittenContent,
  };
}
