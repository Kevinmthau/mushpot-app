import {
  buildDocumentMediaUrl,
  type DocumentMediaBucket,
  MEDIA_URL_CANDIDATE_PATTERN,
  parseDocumentMediaCandidate,
} from "../functions/_shared/document-media-core.ts";

export { DOCUMENT_MEDIA_BUCKETS } from "../functions/_shared/document-media-core.ts";
export type { DocumentMediaBucket } from "../functions/_shared/document-media-core.ts";

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

function parseCandidate(
  value: string,
  supabaseUrl: string,
): { blocker?: string; media?: ParsedCandidate; related: boolean } {
  const candidate = parseDocumentMediaCandidate(value, supabaseUrl);
  if (candidate.status === "unrelated") return { related: false };
  if (candidate.status === "invalid") {
    const label = candidate.reason === "local-url"
      ? "local media URL"
      : candidate.reason === "path"
      ? "document media path"
      : "document media URL";
    return { blocker: `Malformed ${label}: ${value}`, related: true };
  }
  const media = candidate.media;
  return {
    related: true,
    media: {
      bucket: media.bucket,
      documentId: media.documentId.toLowerCase(),
      ownerId: media.ownerId.toLowerCase(),
      fileSegments: media.storagePath.split("/").slice(2),
      originalUrl: value,
      // Storage object names retain their original case even though migration
      // ownership comparisons intentionally normalize UUID identifiers.
      path: media.storagePath,
    },
  };
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
      replacement: buildDocumentMediaUrl(media.bucket, destinationPath),
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
