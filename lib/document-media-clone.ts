import {
  buildDocumentMediaUrl,
  MEDIA_URL_CANDIDATE_PATTERN,
  parseDocumentMediaUrl,
  type DocumentMediaBucket,
} from "@/lib/document-media";
import {
  type DocumentContentFormat,
  HTML_CONTENT_FORMAT,
  MARKDOWN_CONTENT_FORMAT,
  PAGE_JSON_CONTENT_FORMAT,
  parseDocumentContentFormat,
  parsePageDocument,
  rewritePageDocumentMedia,
  serializePageDocument,
} from "@/lib/page-document";

export type DocumentMediaCopy = {
  bucket: DocumentMediaBucket;
  destinationPath: string;
  sourcePath: string;
};

type PlanDocumentMediaCloneOptions = {
  content: string;
  contentFormat: DocumentContentFormat;
  destinationDocumentId: string;
  ownerId: string;
  supabaseUrl: string;
};

type MediaOccurrence = {
  end: number;
  replacement: string;
  start: number;
};

export function planDocumentMediaClone({
  content,
  contentFormat,
  destinationDocumentId,
  ownerId,
  supabaseUrl,
}: PlanDocumentMediaCloneOptions) {
  const copies = new Map<string, DocumentMediaCopy>();
  const planMediaUrl = (value: string) => {
    const media = parseDocumentMediaUrl(value, supabaseUrl);

    if (!media || media.ownerId !== ownerId) {
      return value;
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
    return buildDocumentMediaUrl(media.bucket, destinationPath);
  };

  const format = parseDocumentContentFormat(contentFormat);
  if (format === HTML_CONTENT_FORMAT) {
    return { content, copies: [] };
  }
  if (format === PAGE_JSON_CONTENT_FORMAT) {
    const page = parsePageDocument(content);
    const rewritten = rewritePageDocumentMedia(
      page,
      ({ url }) => planMediaUrl(url),
    );
    return {
      content: serializePageDocument(rewritten),
      copies: Array.from(copies.values()),
    };
  }

  if (format !== MARKDOWN_CONTENT_FORMAT) {
    throw new Error("Unsupported document content format.");
  }

  const occurrences: MediaOccurrence[] = [];
  for (const match of content.matchAll(MEDIA_URL_CANDIDATE_PATTERN)) {
    const value = match[0];
    const start = match.index;
    const replacement = planMediaUrl(value);
    if (replacement === value || start === undefined) continue;
    occurrences.push({
      end: start + value.length,
      replacement,
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
