import {
  buildDocumentMediaUrl,
  parseDocumentMediaUrl,
  type DocumentMediaBucket,
} from "@/lib/document-media";

export type DocumentMediaCopy = {
  bucket: DocumentMediaBucket;
  destinationPath: string;
  sourcePath: string;
};

type PlanDocumentMediaCloneOptions = {
  content: string;
  destinationDocumentId: string;
  ownerId: string;
  supabaseUrl: string;
};

type MediaOccurrence = {
  end: number;
  replacement: string;
  start: number;
};

const MEDIA_URL_CANDIDATE_PATTERN =
  /https?:\/\/[^\s<>"')]+|\/m\/[^\s<>"')]+/g;

export function planDocumentMediaClone({
  content,
  destinationDocumentId,
  ownerId,
  supabaseUrl,
}: PlanDocumentMediaCloneOptions) {
  const copies = new Map<string, DocumentMediaCopy>();
  const occurrences: MediaOccurrence[] = [];

  for (const match of content.matchAll(MEDIA_URL_CANDIDATE_PATTERN)) {
    const value = match[0];
    const start = match.index;
    const media = parseDocumentMediaUrl(value, supabaseUrl);

    if (!media || start === undefined || media.ownerId !== ownerId) {
      continue;
    }

    const relativePath = media.storagePath.split("/").slice(2).join("/");
    // Keep the source document ID below the new document folder so two owned
    // documents with the same relative object name cannot collide.
    const destinationPath =
      `${ownerId}/${destinationDocumentId}/${media.documentId}/${relativePath}`;
    const key = `${media.bucket}\0${media.storagePath}`;

    copies.set(key, {
      bucket: media.bucket,
      destinationPath,
      sourcePath: media.storagePath,
    });
    occurrences.push({
      end: start + value.length,
      replacement: buildDocumentMediaUrl(media.bucket, destinationPath),
      start,
    });
  }

  let rewrittenContent = content;
  for (const occurrence of occurrences.reverse()) {
    rewrittenContent =
      rewrittenContent.slice(0, occurrence.start) +
      occurrence.replacement +
      rewrittenContent.slice(occurrence.end);
  }

  return {
    content: rewrittenContent,
    copies: Array.from(copies.values()),
  };
}
