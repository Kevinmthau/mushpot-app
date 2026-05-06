import type { EditorView } from "@codemirror/view";

export const IMAGE_BUCKET = "document-images";
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
];
export const SUPPORTED_IMAGE_FORMATS_LABEL = SUPPORTED_IMAGE_MIME_TYPES.join(", ");

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

export function sanitizeImageAltText(fileName: string) {
  const withoutExtension = fileName.replace(/\.[^/.]+$/, "");
  const normalized = withoutExtension.replace(/[-_]+/g, " ").trim();
  return normalized || "image";
}

export function sanitizeStorageFileName(fileName: string) {
  const normalized = fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const cleaned = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "image";
}

export function inferImageMimeType(fileName: string) {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = match?.[1];

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
    default:
      return null;
  }
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

export function isSupportedImageFile(file: File) {
  if (file.type) {
    return normalizeImageMimeType(file.type) !== null;
  }

  const extensionMatch = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = extensionMatch?.[1];
  return extension ? SUPPORTED_IMAGE_EXTENSIONS.has(extension) : false;
}

export function buildImageMarkdown(
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
