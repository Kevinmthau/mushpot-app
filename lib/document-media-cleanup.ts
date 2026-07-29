import {
  DOCUMENT_IMAGE_BUCKET,
  DOCUMENT_VIDEO_BUCKET,
  type DocumentMediaBucket,
} from "@/lib/document-media";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

const STORAGE_LIST_PAGE_SIZE = 1_000;
const STORAGE_DELETE_BATCH_SIZE = 100;
const STORAGE_CLEANUP_ATTEMPTS = 3;
const STORAGE_CLEANUP_RETRY_DELAY_MS = 250;

export type ListedDocumentMedia = {
  bucket: DocumentMediaBucket;
  objectPaths: string[];
};

export type MediaCleanupRetryOptions = {
  attempts?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

function wait(delayMs: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

async function listDocumentMediaObjects(
  supabase: SupabaseBrowserClient,
  bucket: DocumentMediaBucket,
  folder: string,
): Promise<string[]> {
  const objectPaths: string[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage.from(bucket).list(folder, {
      limit: STORAGE_LIST_PAGE_SIZE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });

    if (error) {
      throw new Error(`Unable to inspect ${bucket}: ${error.message}`);
    }

    for (const entry of data ?? []) {
      const entryPath = `${folder}/${entry.name}`;

      if (entry.id === null) {
        objectPaths.push(
          ...(await listDocumentMediaObjects(supabase, bucket, entryPath)),
        );
      } else {
        objectPaths.push(entryPath);
      }
    }

    if (!data || data.length < STORAGE_LIST_PAGE_SIZE) {
      break;
    }

    offset += data.length;
  }

  return objectPaths;
}

async function removeDocumentMediaObjects(
  supabase: SupabaseBrowserClient,
  bucket: DocumentMediaBucket,
  objectPaths: string[],
) {
  for (
    let index = 0;
    index < objectPaths.length;
    index += STORAGE_DELETE_BATCH_SIZE
  ) {
    const batch = objectPaths.slice(index, index + STORAGE_DELETE_BATCH_SIZE);
    const { error } = await supabase.storage.from(bucket).remove(batch);

    if (error) {
      throw new Error(`Unable to delete ${bucket}: ${error.message}`);
    }
  }
}

export async function listDocumentMedia(
  supabase: SupabaseBrowserClient,
  owner: string,
  documentId: string,
): Promise<ListedDocumentMedia[]> {
  const folder = `${owner}/${documentId}`;
  const buckets = [
    DOCUMENT_IMAGE_BUCKET,
    DOCUMENT_VIDEO_BUCKET,
  ] as const;
  const objectPathsByBucket = await Promise.all(
    buckets.map((bucket) =>
      listDocumentMediaObjects(supabase, bucket, folder),
    ),
  );

  return buckets.map((bucket, index) => ({
    bucket,
    objectPaths: objectPathsByBucket[index],
  }));
}

export async function cleanupDocumentMediaWithRetry(
  supabase: SupabaseBrowserClient,
  listedMedia: ListedDocumentMedia[],
  {
    attempts = STORAGE_CLEANUP_ATTEMPTS,
    retryDelayMs = STORAGE_CLEANUP_RETRY_DELAY_MS,
    wait: waitForRetry = wait,
  }: MediaCleanupRetryOptions = {},
): Promise<Error | null> {
  let pendingMedia = listedMedia.filter(
    ({ objectPaths }) => objectPaths.length > 0,
  );
  let lastError: unknown = null;

  for (
    let attempt = 1;
    attempt <= attempts && pendingMedia.length > 0;
    attempt += 1
  ) {
    const results = await Promise.allSettled(
      pendingMedia.map(({ bucket, objectPaths }) =>
        removeDocumentMediaObjects(supabase, bucket, objectPaths),
      ),
    );

    const failedMedia: ListedDocumentMedia[] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failedMedia.push(pendingMedia[index]);
        lastError = result.reason;
      }
    });

    pendingMedia = failedMedia;
    if (pendingMedia.length > 0 && attempt < attempts) {
      await waitForRetry(retryDelayMs * 2 ** (attempt - 1));
    }
  }

  if (pendingMedia.length === 0) {
    return null;
  }

  const objectCount = pendingMedia.reduce(
    (total, { objectPaths }) => total + objectPaths.length,
    0,
  );
  const reason = lastError instanceof Error ? ` ${lastError.message}` : "";

  return new Error(
    `Unable to remove ${objectCount} private media object${objectCount === 1 ? "" : "s"} after ${attempts} attempts.${reason}`,
  );
}
