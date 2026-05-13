"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import {
  buildEmbeddedMediaMarkdown,
  ensureStorageFileNameMatchesMediaKind,
  getDocumentMediaBucket,
  getSupportedMediaKind,
  inferMediaMimeType,
  isSupportedMediaFile,
  MAX_IMAGE_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
  normalizeMediaMimeType,
  sanitizeMediaAltText,
  sanitizeStorageFileName,
  SUPPORTED_MEDIA_FORMATS_LABEL,
  type SupportedMediaKind,
} from "@/components/editor/image-upload-utils";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type UseMediaUploadInsertionParams = {
  documentId: string;
  owner: string;
};

function getMediaUploadLimit(kind: SupportedMediaKind) {
  return kind === "video" ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;
}

function formatMegabytes(bytes: number) {
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

export function useMediaUploadInsertion({
  documentId,
  owner,
}: UseMediaUploadInsertionParams) {
  const [uploadingMediaCount, setUploadingMediaCount] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const insertUploadedMedia = useCallback(
    async (view: EditorView, files: File[], initialInsertPosition: number) => {
      if (files.length === 0) {
        return;
      }

      setUploadingMediaCount((count) => count + files.length);

      let insertPosition = initialInsertPosition;
      const failures: string[] = [];
      try {
        for (const file of files) {
          const mediaKind = getSupportedMediaKind(file);
          if (!mediaKind) {
            failures.push(
              `${file.name || "File"} is not a supported media file. Allowed formats: ${SUPPORTED_MEDIA_FORMATS_LABEL}.`,
            );
            continue;
          }

          const uploadLimit = getMediaUploadLimit(mediaKind);
          if (file.size > uploadLimit) {
            failures.push(
              `${file.name || "File"} exceeds the ${formatMegabytes(uploadLimit)} upload limit.`,
            );
            continue;
          }

          try {
            const supabase = await getSupabaseBrowserClient();
            const inferredMimeType = inferMediaMimeType(file.name);
            const normalizedMimeType = file.type
              ? normalizeMediaMimeType(file.type)?.mimeType
              : null;
            const contentType = normalizedMimeType || inferredMimeType || undefined;
            const safeName = ensureStorageFileNameMatchesMediaKind(
              sanitizeStorageFileName(file.name),
              mediaKind,
              contentType,
            );
            const randomId = crypto.randomUUID();
            const path = `${owner}/${documentId}/${randomId}-${safeName}`;
            const bucket = getDocumentMediaBucket(mediaKind);

            const { error } = await supabase.storage
              .from(bucket)
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

            const { data } = supabase.storage.from(bucket).getPublicUrl(path);
            const markdownMedia = buildEmbeddedMediaMarkdown(
              view,
              insertPosition,
              sanitizeMediaAltText(file.name, mediaKind),
              data.publicUrl,
            );
            const safeInsertPosition = Math.min(insertPosition, view.state.doc.length);
            view.dispatch({
              changes: {
                from: safeInsertPosition,
                to: safeInsertPosition,
                insert: markdownMedia,
              },
              selection: {
                anchor: safeInsertPosition + markdownMedia.length,
              },
            });
            insertPosition = safeInsertPosition + markdownMedia.length;
          } catch (error) {
            console.error("Media upload failed", error);
            failures.push(`Failed to upload ${file.name || "a file"}.`);
          }
        }
      } finally {
        setUploadingMediaCount((count) => Math.max(0, count - files.length));
      }

      if (failures.length > 0) {
        window.alert(failures.join("\n"));
      }
    },
    [documentId, owner],
  );

  const mediaDropPasteHandlers = useMemo(
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

          const files = droppedFiles.filter(isSupportedMediaFile);
          if (files.length === 0) {
            window.alert(
              `Only image and video files are supported. Allowed formats: ${SUPPORTED_MEDIA_FORMATS_LABEL}.`,
            );
            return true;
          }

          const dropPosition =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.from;
          void insertUploadedMedia(view, files, dropPosition);
          return true;
        },
        paste: (event, view) => {
          const pastedFiles = Array.from(event.clipboardData?.files ?? []);
          if (pastedFiles.length === 0) {
            return false;
          }

          event.preventDefault();

          const files = pastedFiles.filter(isSupportedMediaFile);
          if (files.length === 0) {
            window.alert(
              `Only image and video files are supported. Allowed formats: ${SUPPORTED_MEDIA_FORMATS_LABEL}.`,
            );
            return true;
          }

          void insertUploadedMedia(view, files, view.state.selection.main.from);
          return true;
        },
      }),
    [insertUploadedMedia],
  );

  return {
    mediaDropPasteHandlers,
    uploadingMediaCount,
  };
}
