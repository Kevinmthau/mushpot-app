"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import {
  buildEmbeddedMediaMarkdown,
  DOCUMENT_IMAGE_BUCKET,
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
import { generateVideoPosterImage } from "@/components/editor/video-poster-utils";
import { buildVideoPosterTitle } from "@/lib/markdown/video-poster";
import {
  getSupabaseBrowserClient,
  type SupabaseBrowserClient,
} from "@/lib/supabase/client";

type UseMediaUploadInsertionParams = {
  documentId: string;
  owner: string;
};

const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024;
const TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024;

function getMediaUploadLimit(kind: SupportedMediaKind) {
  return kind === "video" ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;
}

function formatFileSize(bytes: number) {
  const megabytes = bytes / (1024 * 1024);
  const roundedMegabytes = Math.round(megabytes);

  if (Math.abs(megabytes - roundedMegabytes) < 0.05) {
    return `${roundedMegabytes}MB`;
  }

  return `${megabytes.toFixed(1)}MB`;
}

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function getUploadLimitExceededMessage(
  file: File,
  kind: SupportedMediaKind,
  limit: number,
) {
  const suggestion =
    kind === "video"
      ? "Compress the file or upload a shorter clip."
      : "Compress the file or choose a smaller image.";
  return `${file.name || "File"} is ${formatFileSize(file.size)}. ${capitalize(kind)} uploads are limited to ${formatFileSize(limit)}. ${suggestion}`;
}

function getRequiredEnvValue(name: string, value: string | undefined) {
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }

  return value;
}

function getResumableUploadEndpoint(supabaseUrlValue: string) {
  const supabaseUrl = new URL(supabaseUrlValue);
  const hostParts = supabaseUrl.hostname.split(".");

  if (
    hostParts.length === 3 &&
    hostParts[1] === "supabase" &&
    hostParts[2] === "co"
  ) {
    supabaseUrl.hostname = `${hostParts[0]}.storage.supabase.co`;
  }

  supabaseUrl.pathname = "/storage/v1/upload/resumable";
  supabaseUrl.search = "";
  supabaseUrl.hash = "";

  return supabaseUrl.toString();
}

async function uploadMediaWithResumableUpload({
  bucket,
  contentType,
  file,
  path,
  supabase,
}: {
  bucket: string;
  contentType: string | undefined;
  file: File;
  path: string;
  supabase: SupabaseBrowserClient;
}) {
  const supabaseUrl = getRequiredEnvValue(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  const supabaseAnonKey = getRequiredEnvValue(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  const { Upload } = await import("tus-js-client");
  let uploadedPath = path;

  await new Promise<void>((resolve, reject) => {
    const pathFolder = path.slice(0, path.lastIndexOf("/") + 1);
    const upload = new Upload(file, {
      endpoint: getResumableUploadEndpoint(supabaseUrl),
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        apikey: supabaseAnonKey,
      },
      async onBeforeRequest(request) {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) {
          throw sessionError;
        }

        if (!session?.access_token) {
          throw new Error("Missing Supabase session for upload.");
        }

        request.setHeader("authorization", `Bearer ${session.access_token}`);
      },
      uploadDataDuringCreation: true,
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      chunkSize: TUS_CHUNK_SIZE_BYTES,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: contentType || file.type || "application/octet-stream",
        cacheControl: "3600",
      },
      onError(error) {
        reject(error);
      },
      onSuccess() {
        resolve();
      },
    });

    upload
      .findPreviousUploads()
      .then((previousUploads) => {
        const previousUpload = previousUploads.find(
          (candidate) =>
            candidate.metadata.bucketName === bucket &&
            candidate.metadata.objectName.startsWith(pathFolder),
        );

        if (previousUpload) {
          uploadedPath = previousUpload.metadata.objectName;
          upload.options.metadata = {
            ...upload.options.metadata,
            bucketName: bucket,
            objectName: uploadedPath,
          };
          upload.resumeFromPreviousUpload(previousUpload);
        }

        upload.start();
      })
      .catch(reject);
  });

  return uploadedPath;
}

async function uploadMediaToStorage({
  bucket,
  contentType,
  file,
  path,
  supabase,
}: {
  bucket: string;
  contentType: string | undefined;
  file: File;
  path: string;
  supabase: SupabaseBrowserClient;
}) {
  if (file.size > RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
    return uploadMediaWithResumableUpload({
      bucket,
      contentType,
      file,
      path,
      supabase,
    });
  }

  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType,
    upsert: false,
  });

  if (error) {
    throw error;
  }

  return path;
}

async function uploadVideoPosterImage({
  documentId,
  owner,
  poster,
  randomId,
  supabase,
}: {
  documentId: string;
  owner: string;
  poster: File;
  randomId: string;
  supabase: SupabaseBrowserClient;
}) {
  try {
    const path = `${owner}/${documentId}/${randomId}-poster.jpg`;
    const uploadedPath = await uploadMediaToStorage({
      bucket: DOCUMENT_IMAGE_BUCKET,
      contentType: "image/jpeg",
      file: poster,
      path,
      supabase,
    });
    const { data } = supabase.storage
      .from(DOCUMENT_IMAGE_BUCKET)
      .getPublicUrl(uploadedPath);
    return data.publicUrl;
  } catch (error) {
    console.error("Video poster upload failed", error);
    return null;
  }
}

function getErrorValue(error: unknown, key: string) {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return null;
  }

  return (error as Record<string, unknown>)[key];
}

function getUploadErrorStatusCode(error: unknown) {
  for (const key of ["status", "statusCode"]) {
    const value = getErrorValue(error, key);

    if (typeof value === "number") {
      return value;
    }

    if (typeof value === "string") {
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isNaN(parsedValue)) {
        return parsedValue;
      }
    }
  }

  return null;
}

function getUploadErrorText(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  const message = getErrorValue(error, "message");

  if (typeof message === "string") {
    return message;
  }

  return null;
}

function isStorageMaximumSizeError(error: unknown) {
  const message = getUploadErrorText(error)?.toLowerCase() ?? "";
  return (
    getUploadErrorStatusCode(error) === 413 ||
    message.includes("response code: 413") ||
    message.includes("maximum size exceeded")
  );
}

function getUploadErrorMessage(
  error: unknown,
  file: File,
  kind: SupportedMediaKind,
  limit: number,
) {
  if (isStorageMaximumSizeError(error)) {
    if (file.size > limit) {
      return getUploadLimitExceededMessage(file, kind, limit);
    }

    console.error(
      `Storage rejected ${kind} upload as too large despite file size ${formatFileSize(file.size)} being under the Mushpot ${kind} limit of ${formatFileSize(limit)}. The Supabase global Storage limit may be lower than the Mushpot limit.`,
    );
    return `${file.name || "File"} is too large to upload.`;
  }

  return getUploadErrorText(error);
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
            failures.push(getUploadLimitExceededMessage(file, mediaKind, uploadLimit));
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

            const posterImagePromise =
              mediaKind === "video"
                ? generateVideoPosterImage(file)
                : Promise.resolve(null);

            const uploadedPath = await uploadMediaToStorage({
              bucket,
              contentType,
              file,
              path,
              supabase,
            });

            if (!mountedRef.current) {
              return;
            }

            const { data } = supabase.storage.from(bucket).getPublicUrl(uploadedPath);

            let posterTitle: string | undefined;
            const posterImage = await posterImagePromise;
            if (posterImage) {
              const posterUrl = await uploadVideoPosterImage({
                documentId,
                owner,
                poster: posterImage,
                randomId,
                supabase,
              });
              if (posterUrl) {
                posterTitle = buildVideoPosterTitle(posterUrl);
              }
            }

            if (!mountedRef.current) {
              return;
            }

            const markdownMedia = buildEmbeddedMediaMarkdown(
              view,
              insertPosition,
              sanitizeMediaAltText(file.name, mediaKind),
              data.publicUrl,
              posterTitle,
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
            const message = getUploadErrorMessage(
              error,
              file,
              mediaKind,
              uploadLimit,
            );
            failures.push(
              message
                ? `Failed to upload ${file.name || "a file"}: ${message}`
                : `Failed to upload ${file.name || "a file"}.`,
            );
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
