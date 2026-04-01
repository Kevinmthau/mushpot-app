"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

const IMAGE_BUCKET = "document-images";
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "svg",
]);
const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
];
const SUPPORTED_IMAGE_MIME_TYPE_SET = new Set([
  ...SUPPORTED_IMAGE_MIME_TYPES,
  "image/jpg",
]);
const SUPPORTED_IMAGE_FORMATS_LABEL = SUPPORTED_IMAGE_MIME_TYPES.join(", ");

function sanitizeImageAltText(fileName: string) {
  const withoutExtension = fileName.replace(/\.[^/.]+$/, "");
  const normalized = withoutExtension.replace(/[-_]+/g, " ").trim();
  return normalized || "image";
}

function sanitizeStorageFileName(fileName: string) {
  const normalized = fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const cleaned = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "image";
}

function inferImageMimeType(fileName: string) {
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

function normalizeImageMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpg") {
    return "image/jpeg";
  }

  if (SUPPORTED_IMAGE_MIME_TYPE_SET.has(normalized)) {
    return normalized;
  }

  return null;
}

function isSupportedImageFile(file: File) {
  if (file.type) {
    return normalizeImageMimeType(file.type) !== null;
  }

  const extensionMatch = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = extensionMatch?.[1];
  return extension ? SUPPORTED_IMAGE_EXTENSIONS.has(extension) : false;
}

function buildImageMarkdown(
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

type UseImageUploadInsertionParams = {
  documentId: string;
  owner: string;
};

export function useImageUploadInsertion({
  documentId,
  owner,
}: UseImageUploadInsertionParams) {
  const [uploadingImagesCount, setUploadingImagesCount] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const insertUploadedImages = useCallback(
    async (view: EditorView, files: File[], initialInsertPosition: number) => {
      if (files.length === 0) {
        return;
      }

      setUploadingImagesCount((count) => count + files.length);

      let insertPosition = initialInsertPosition;
      const failures: string[] = [];
      try {
        for (const file of files) {
          if (!isSupportedImageFile(file)) {
            failures.push(
              `${file.name || "File"} is not a supported image. Allowed formats: ${SUPPORTED_IMAGE_FORMATS_LABEL}.`,
            );
            continue;
          }

          if (file.size > MAX_IMAGE_SIZE_BYTES) {
            failures.push(`${file.name || "Image"} exceeds the 10MB upload limit.`);
            continue;
          }

          try {
            const supabase = await getSupabaseBrowserClient();
            const safeName = sanitizeStorageFileName(file.name);
            const randomId =
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            const path = `${owner}/${documentId}/${randomId}-${safeName}`;
            const inferredMimeType = inferImageMimeType(file.name);
            const normalizedMimeType = file.type ? normalizeImageMimeType(file.type) : null;
            const contentType = normalizedMimeType || inferredMimeType || undefined;

            const { error } = await supabase.storage
              .from(IMAGE_BUCKET)
              .upload(path, file, {
                contentType,
                upsert: false,
              });

            if (error) {
              throw error;
            }

            if (!mountedRef.current) {
              return;
            }

            const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
            const markdownImage = buildImageMarkdown(
              view,
              insertPosition,
              sanitizeImageAltText(file.name),
              data.publicUrl,
            );
            const safeInsertPosition = Math.min(insertPosition, view.state.doc.length);
            view.dispatch({
              changes: {
                from: safeInsertPosition,
                to: safeInsertPosition,
                insert: markdownImage,
              },
              selection: {
                anchor: safeInsertPosition + markdownImage.length,
              },
            });
            insertPosition = safeInsertPosition + markdownImage.length;
          } catch (error) {
            console.error("Image upload failed", error);
            failures.push(`Failed to upload ${file.name || "an image"}.`);
          }
        }
      } finally {
        setUploadingImagesCount((count) => Math.max(0, count - files.length));
      }

      if (failures.length > 0) {
        window.alert(failures.join("\n"));
      }
    },
    [documentId, owner],
  );

  const imageDropPasteHandlers = useMemo(
    () =>
      EditorView.domEventHandlers({
        dragover: (event) => {
          const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes("Files");
          if (!hasFiles) {
            return false;
          }

          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "copy";
          }
          return true;
        },
        drop: (event, view) => {
          const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
          if (droppedFiles.length === 0) {
            return false;
          }

          event.preventDefault();

          const files = droppedFiles.filter(isSupportedImageFile);
          if (files.length === 0) {
            window.alert(
              `Only image files are supported. Allowed formats: ${SUPPORTED_IMAGE_FORMATS_LABEL}.`,
            );
            return true;
          }

          const dropPosition =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.from;
          void insertUploadedImages(view, files, dropPosition);
          return true;
        },
        paste: (event, view) => {
          const pastedFiles = Array.from(event.clipboardData?.files ?? []);
          if (pastedFiles.length === 0) {
            return false;
          }

          event.preventDefault();

          const files = pastedFiles.filter(isSupportedImageFile);
          if (files.length === 0) {
            window.alert(
              `Only image files are supported. Allowed formats: ${SUPPORTED_IMAGE_FORMATS_LABEL}.`,
            );
            return true;
          }

          void insertUploadedImages(view, files, view.state.selection.main.from);
          return true;
        },
      }),
    [insertUploadedImages],
  );

  return {
    imageDropPasteHandlers,
    uploadingImagesCount,
  };
}
