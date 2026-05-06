"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import {
  buildImageMarkdown,
  IMAGE_BUCKET,
  inferImageMimeType,
  isSupportedImageFile,
  MAX_IMAGE_SIZE_BYTES,
  normalizeImageMimeType,
  sanitizeImageAltText,
  sanitizeStorageFileName,
  SUPPORTED_IMAGE_FORMATS_LABEL,
} from "@/components/editor/image-upload-utils";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

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
            const randomId = crypto.randomUUID();
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
