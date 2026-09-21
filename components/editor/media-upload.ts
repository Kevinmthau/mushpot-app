import {
  DOCUMENT_IMAGE_BUCKET,
  ensureStorageFileNameMatchesMediaKind,
  getDocumentMediaBucket,
  getSupportedMediaKind,
  inferMediaMimeType,
  MAX_IMAGE_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
  normalizeMediaMimeType,
  sanitizeMediaAltText,
  sanitizeStorageFileName,
  SUPPORTED_MEDIA_FORMATS_LABEL,
  type SupportedMediaKind,
} from "@/components/editor/image-upload-utils";
import { generateVideoPosterImage } from "@/components/editor/video-poster-utils";
import { buildDocumentMediaUrl } from "@/lib/document-media";
import { buildVideoPosterTitle } from "@/lib/markdown/video-poster";
import {
  getSupabaseBrowserClient,
  type SupabaseBrowserClient,
} from "@/lib/supabase/client";

const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024;
const TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024;

// Supabase's standard upload API has no AbortSignal option. Stop awaiting it
// immediately on cancellation, but still observe its eventual rejection. A
// request already sent may finish in Storage; it must never insert stale media.
function waitForUpload<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

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
  signal,
  supabase,
}: {
  bucket: string;
  contentType: string | undefined;
  file: File;
  path: string;
  signal: AbortSignal;
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
  signal.throwIfAborted();
  let uploadedPath = path;

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const pathFolder = path.slice(0, path.lastIndexOf("/") + 1);
    const upload = new Upload(file, {
      endpoint: getResumableUploadEndpoint(supabaseUrl),
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        apikey: supabaseAnonKey,
      },
      async onBeforeRequest(request) {
        signal.throwIfAborted();
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();
        signal.throwIfAborted();

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
        cacheControl: "300",
      },
      onError(error) {
        finish(error);
      },
      onSuccess() {
        finish();
      },
    });

    const abort = () => {
      // Keep the fingerprint so a later upload can resume the partial file.
      void upload.abort().catch(() => {});
      finish(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });

    upload
      .findPreviousUploads()
      .then((previousUploads) => {
        signal.throwIfAborted();
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
      .catch(finish);
  });

  return uploadedPath;
}

async function uploadMediaToStorage({
  bucket,
  contentType,
  file,
  path,
  signal,
  supabase,
}: {
  bucket: string;
  contentType: string | undefined;
  file: File;
  path: string;
  signal: AbortSignal;
  supabase: SupabaseBrowserClient;
}) {
  signal.throwIfAborted();
  if (file.size > RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
    return uploadMediaWithResumableUpload({
      bucket,
      contentType,
      file,
      path,
      signal,
      supabase,
    });
  }

  const { error } = await waitForUpload(supabase.storage.from(bucket).upload(path, file, {
    cacheControl: "300",
    contentType,
    upsert: false,
  }), signal);
  signal.throwIfAborted();

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
  signal,
  supabase,
}: {
  documentId: string;
  owner: string;
  poster: File;
  randomId: string;
  signal: AbortSignal;
  supabase: SupabaseBrowserClient;
}) {
  try {
    const path = `${owner}/${documentId}/${randomId}-poster.jpg`;
    const uploadedPath = await uploadMediaToStorage({
      bucket: DOCUMENT_IMAGE_BUCKET,
      contentType: "image/jpeg",
      file: poster,
      path,
      signal,
      supabase,
    });
    return buildDocumentMediaUrl(DOCUMENT_IMAGE_BUCKET, uploadedPath);
  } catch (error) {
    signal.throwIfAborted();
    console.error("Video poster upload failed", error);
    return null;
  }
}

export function isolateVideoPosterImagePromise(
  posterImagePromise: Promise<File | null>,
) {
  return posterImagePromise.catch((error) => {
    // Attach the rejection handler as soon as extraction starts. Waiting until
    // after the video upload would leave this promise abandoned when the upload
    // fails or the editor unmounts first.
    console.error("Video poster generation failed", error);
    return null;
  });
}

export async function resolveVideoPosterTitle({
  documentId,
  owner,
  posterImagePromise,
  randomId,
  signal = new AbortController().signal,
  supabase,
}: {
  documentId: string;
  owner: string;
  posterImagePromise: Promise<File | null>;
  randomId: string;
  signal?: AbortSignal;
  supabase: SupabaseBrowserClient;
}) {
  try {
    const posterImage = await waitForUpload(posterImagePromise, signal);
    signal.throwIfAborted();
    if (!posterImage) {
      return undefined;
    }

    const posterUrl = await uploadVideoPosterImage({
      documentId,
      owner,
      poster: posterImage,
      randomId,
      signal,
      supabase,
    });
    return posterUrl ? buildVideoPosterTitle(posterUrl) : undefined;
  } catch (error) {
    signal.throwIfAborted();
    // Poster extraction is best-effort. A rejected extraction promise must
    // never turn an already uploaded video into a reported upload failure.
    console.error("Video poster generation failed", error);
    return undefined;
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

export type MediaUploadResult =
  | { status: "uploaded"; media: { url: string; altText: string; posterTitle?: string } }
  | { status: "failed"; message: string }
  | { status: "cancelled" };

export async function uploadDocumentMedia({
  documentId,
  owner,
  file,
  signal,
}: {
  documentId: string;
  owner: string;
  file: File;
  signal: AbortSignal;
}): Promise<MediaUploadResult> {
  if (signal.aborted) return { status: "cancelled" };
  const kind = getSupportedMediaKind(file);
  if (!kind) {
    return {
      status: "failed",
      message: `${file.name || "File"} is not a supported media file. Allowed formats: ${SUPPORTED_MEDIA_FORMATS_LABEL}.`,
    };
  }
  const limit = getMediaUploadLimit(kind);
  if (file.size > limit) {
    return { status: "failed", message: getUploadLimitExceededMessage(file, kind, limit) };
  }

  const posterController = new AbortController();
  const cancelPoster = () => posterController.abort();
  signal.addEventListener("abort", cancelPoster, { once: true });
  try {
    const supabase = await waitForUpload(getSupabaseBrowserClient(), signal);
    signal.throwIfAborted();
    const contentType = (file.type ? normalizeMediaMimeType(file.type)?.mimeType : null)
      || inferMediaMimeType(file.name) || undefined;
    const safeName = ensureStorageFileNameMatchesMediaKind(
      sanitizeStorageFileName(file.name), kind, contentType,
    );
    const randomId = crypto.randomUUID();
    const path = `${owner}/${documentId}/${randomId}-${safeName}`;
    const bucket = getDocumentMediaBucket(kind);
    const posterImagePromise = kind === "video"
      ? isolateVideoPosterImagePromise(generateVideoPosterImage(file, posterController.signal))
      : Promise.resolve(null);
    const uploadedPath = await uploadMediaToStorage({
      bucket, contentType, file, path, signal, supabase,
    });
    signal.throwIfAborted();
    const posterTitle = await resolveVideoPosterTitle({
      documentId, owner, posterImagePromise, randomId, signal, supabase,
    });
    signal.throwIfAborted();
    return {
      status: "uploaded",
      media: {
        url: buildDocumentMediaUrl(bucket, uploadedPath),
        altText: sanitizeMediaAltText(file.name, kind),
        posterTitle,
      },
    };
  } catch (error) {
    if (signal.aborted) return { status: "cancelled" };
    console.error("Media upload failed", error);
    const message = getUploadErrorMessage(error, file, kind, limit);
    return {
      status: "failed",
      message: message
        ? `Failed to upload ${file.name || "a file"}: ${message}`
        : `Failed to upload ${file.name || "a file"}.`,
    };
  } finally {
    signal.removeEventListener("abort", cancelPoster);
    posterController.abort();
  }
}
