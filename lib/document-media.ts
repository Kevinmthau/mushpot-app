import {
  normalizeDocumentMediaUrl as normalizeMediaUrl,
  parseDocumentMediaUrl as parseMediaUrl,
} from "@/supabase/functions/_shared/document-media-core";

export {
  buildDocumentMediaUrl,
  DOCUMENT_IMAGE_BUCKET,
  DOCUMENT_MEDIA_BATCH_MAX_URLS,
  DOCUMENT_MEDIA_BUCKETS,
  DOCUMENT_MEDIA_MAX_URL_LENGTH,
  DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS,
  DOCUMENT_VIDEO_BUCKET,
  isDocumentMediaBucket,
  isUuid,
  parseDocumentMediaRoute,
  type DocumentMediaBucket,
  type DocumentMediaRoute,
  type SharedMediaBatchResponse,
  type SharedMediaUrlResult,
} from "@/supabase/functions/_shared/document-media-core";

export function parseDocumentMediaUrl(
  value: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
) {
  return parseMediaUrl(value, supabaseUrl);
}

export function normalizeDocumentMediaUrl(
  value: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
) {
  return normalizeMediaUrl(value, supabaseUrl);
}
