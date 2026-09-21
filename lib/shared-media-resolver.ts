import {
  DOCUMENT_MEDIA_BATCH_MAX_URLS,
  DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS,
  type SharedMediaUrlResult,
} from "@/lib/document-media";

type ResolvedMedia = { url: string | null; expiresAt: number };
type PendingMedia = {
  resolve: (value: ResolvedMedia) => void;
  promise: Promise<ResolvedMedia>;
};

const BATCH_TIMEOUT_MS = 10_000;

// This resolver is scoped to one mounted shared page, never persistent storage.
export function createSharedMediaResolver(
  documentId: string,
  token: string,
  fetcher = fetch,
) {
  const prefix = `/s/${documentId}/${token}`;
  const pending = new Map<string, PendingMedia>();
  const queue = new Set<string>();
  const cache = new Map<string, ResolvedMedia>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let batchUnavailable = false;

  function mediaPath(url: string) {
    return url.startsWith(`${prefix}/m/`)
      ? url.slice(prefix.length).split("#")[0]
      : null;
  }

  async function requestBatch(sources: string[]) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Shared media batch timed out."));
        }, BATCH_TIMEOUT_MS);
      });
      return await Promise.race([
        fetcher(`${prefix}/media`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mediaUrls: sources.map((url) => mediaPath(url)),
          }),
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        }).then(async (response) => ({
          ok: response.ok,
          status: response.status,
          // Include body consumption in the deadline: headers alone do not
          // unblock the other media queued behind this batch.
          body: response.ok ? await response.json() : null,
        })),
        deadline,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function flush() {
    timer = undefined;
    if (running || queue.size === 0) return;
    running = true;
    const sources = Array.from(queue).slice(0, DOCUMENT_MEDIA_BATCH_MAX_URLS);
    sources.forEach((url) => queue.delete(url));
    const startedAt = Date.now();
    let urls:
      | SharedMediaUrlResult[]
      | null = null;
    let expiresIn = 0;
    try {
      if (!batchUnavailable) {
        const response = await requestBatch(sources);
        if (response.ok) {
          const body = response.body;
          if (
            Array.isArray(body.urls) && body.urls.every((item: unknown) =>
              typeof item === "object" && item !== null && "mediaUrl" in item &&
              typeof item.mediaUrl === "string" && "signedUrl" in item &&
              (item.signedUrl === null || typeof item.signedUrl === "string")
            ) &&
            typeof body.expiresIn === "number"
          ) {
            urls = body.urls;
            expiresIn = Math.max(0, Math.min(DOCUMENT_MEDIA_SIGNED_URL_TTL_SECONDS, body.expiresIn));
          }
        } else if (response.status === 503 || response.status === 404) {
          batchUnavailable = true;
        }
      }
    } catch {
      /* The stable single-media route remains a network-error fallback. */
    }
    const signed = new Map(urls?.map((item) => [item.mediaUrl, item]));
    for (const source of sources) {
      const item = signed.get(mediaPath(source)!);
      const signedUrl = item?.signedUrl;
      const fragment = source.includes("#")
        ? source.slice(source.indexOf("#"))
        : "";
      const expiresAt = startedAt + Math.max(0, expiresIn - 15) * 1000;
      const fallback = urls === null || item?.retry === true ||
        Boolean(signedUrl && expiresAt <= Date.now());
      const resolved = {
        url: fallback ? source : (signedUrl ? signedUrl + fragment : null),
        expiresAt: fallback ? 0 : expiresAt,
      };
      if (resolved.url && resolved.expiresAt > Date.now()) {
        cache.set(source, resolved);
      }
      pending.get(source)?.resolve(resolved);
      pending.delete(source);
    }
    running = false;
    if (queue.size > 0) schedule();
  }

  function schedule() {
    if (!running && timer === undefined) {
      timer = setTimeout(() => void flush(), 16);
    }
  }

  return {
    isShared: (url: string) => mediaPath(url) !== null,
    resolve(url: string, refresh = false): Promise<ResolvedMedia> {
      if (!mediaPath(url)) return Promise.resolve({ url, expiresAt: Infinity });
      if (refresh) cache.delete(url);
      const cached = cache.get(url);
      if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached);
      }
      const existing = pending.get(url);
      if (existing) return existing.promise;
      let resolve!: PendingMedia["resolve"];
      const promise = new Promise<ResolvedMedia>((done) => {
        resolve = done;
      });
      pending.set(url, { promise, resolve });
      queue.add(url);
      schedule();
      return promise;
    },
  };
}
