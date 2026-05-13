import type { EditorView } from "@codemirror/view";

export type SupportedMediaKind = "image" | "video";

export const DOCUMENT_IMAGE_BUCKET = "document-images";
export const DOCUMENT_VIDEO_BUCKET = "document-videos";
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
];
export const SUPPORTED_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];
export const SUPPORTED_MEDIA_FORMATS_LABEL =
  ".jpg, .jpeg, .png, .webp, .gif, .avif, .svg, .mp4, .mov";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "svg",
]);
const SUPPORTED_IMAGE_MIME_TYPE_SET = new Set([
  ...SUPPORTED_IMAGE_MIME_TYPES,
  "image/jpg",
]);
const SUPPORTED_VIDEO_EXTENSIONS = new Set(["mp4", "mov"]);
const SUPPORTED_VIDEO_MIME_TYPE_SET = new Set(SUPPORTED_VIDEO_MIME_TYPES);
const PREFERRED_MEDIA_EXTENSION_BY_MIME_TYPE = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
  ["image/svg+xml", "svg"],
  ["video/mp4", "mp4"],
  ["video/quicktime", "mov"],
]);

function getFileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/);
  return match?.[1] ?? null;
}

function getSupportedMediaKindFromExtension(extension: string | null) {
  if (!extension) {
    return null;
  }

  if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (SUPPORTED_VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }

  return null;
}

function decodeUrlPath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getUrlFileExtension(src: string) {
  try {
    const url = new URL(src, "https://mushpot.local");
    return getFileExtension(decodeUrlPath(url.pathname));
  } catch {
    const [path] = src.split(/[?#]/, 1);
    return getFileExtension(decodeUrlPath(path ?? src));
  }
}

export function sanitizeMediaAltText(fileName: string, fallback: string) {
  const withoutExtension = fileName.replace(/\.[^/.]+$/, "");
  const normalized = withoutExtension.replace(/[-_]+/g, " ").trim();
  return normalized || fallback;
}

export function sanitizeImageAltText(fileName: string) {
  return sanitizeMediaAltText(fileName, "image");
}

export function sanitizeStorageFileName(fileName: string) {
  const normalized = fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const cleaned = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "file";
}

function replaceFileExtension(fileName: string, extension: string) {
  const withoutExtension = fileName.replace(/\.[^/.]+$/, "");
  const baseName = withoutExtension.replace(/\.+$/g, "") || "file";
  return `${baseName}.${extension}`;
}

export function getDocumentMediaBucket(kind: SupportedMediaKind) {
  return kind === "video" ? DOCUMENT_VIDEO_BUCKET : DOCUMENT_IMAGE_BUCKET;
}

export function ensureStorageFileNameMatchesMediaKind(
  fileName: string,
  kind: SupportedMediaKind,
  mimeType: string | null | undefined,
) {
  const extensionKind = getSupportedMediaKindFromExtension(getFileExtension(fileName));
  if (extensionKind === kind || (kind === "image" && extensionKind === null)) {
    return fileName;
  }

  const preferredExtension = mimeType
    ? PREFERRED_MEDIA_EXTENSION_BY_MIME_TYPE.get(mimeType)
    : null;
  return replaceFileExtension(fileName, preferredExtension ?? (kind === "video" ? "mp4" : "jpg"));
}

export function inferMediaMimeType(fileName: string) {
  const extension = getFileExtension(fileName);

  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    default:
      return null;
  }
}

export function inferImageMimeType(fileName: string) {
  const mimeType = inferMediaMimeType(fileName);
  return mimeType?.startsWith("image/") ? mimeType : null;
}

export function inferVideoMimeType(fileName: string) {
  const mimeType = inferMediaMimeType(fileName);
  return mimeType?.startsWith("video/") ? mimeType : null;
}

export function normalizeImageMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpg") {
    return "image/jpeg";
  }

  if (SUPPORTED_IMAGE_MIME_TYPE_SET.has(normalized)) {
    return normalized;
  }

  return null;
}

export function normalizeVideoMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (SUPPORTED_VIDEO_MIME_TYPE_SET.has(normalized)) {
    return normalized;
  }

  return null;
}

export function normalizeMediaMimeType(mimeType: string) {
  const imageMimeType = normalizeImageMimeType(mimeType);
  if (imageMimeType) {
    return {
      kind: "image" as const,
      mimeType: imageMimeType,
    };
  }

  const videoMimeType = normalizeVideoMimeType(mimeType);
  if (videoMimeType) {
    return {
      kind: "video" as const,
      mimeType: videoMimeType,
    };
  }

  return null;
}

export function getSupportedMediaKind(file: File): SupportedMediaKind | null {
  const mimeTypeMatch = file.type ? normalizeMediaMimeType(file.type) : null;
  if (mimeTypeMatch) {
    return mimeTypeMatch.kind;
  }

  return getSupportedMediaKindFromExtension(getFileExtension(file.name));
}

export function isSupportedMediaFile(file: File) {
  return getSupportedMediaKind(file) !== null;
}

export function isSupportedImageFile(file: File) {
  return getSupportedMediaKind(file) === "image";
}

export function isSupportedVideoFile(file: File) {
  return getSupportedMediaKind(file) === "video";
}

export function isSupportedVideoUrl(src: string) {
  const extension = getUrlFileExtension(src);
  return extension ? SUPPORTED_VIDEO_EXTENSIONS.has(extension) : false;
}

export function buildEmbeddedMediaMarkdown(
  view: EditorView,
  position: number,
  altText: string,
  url: string,
) {
  const before = position > 0 ? view.state.doc.sliceString(position - 1, position) : "\n";
  const after =
    position < view.state.doc.length
      ? view.state.doc.sliceString(position, position + 1)
      : "\n";
  const prefix = before === "\n" ? "" : "\n";
  const suffix = after === "\n" ? "\n" : "\n\n";
  return `${prefix}![${altText}](${url})${suffix}`;
}

export function buildImageMarkdown(
  view: EditorView,
  position: number,
  altText: string,
  url: string,
) {
  return buildEmbeddedMediaMarkdown(view, position, altText, url);
}
