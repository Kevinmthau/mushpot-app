import {
  type LinkPreviewMetadata,
  normalizeLinkPreviewUrl,
} from "@/lib/link-preview";

const CACHE_LIMIT = 100;
const CONCURRENT_REQUESTS = 4;
const SUCCESS_TTL = 30 * 60 * 1000;
const FAILURE_TTL = 60 * 1000;
const REQUEST_TIMEOUT = 12_000;

type CacheEntry = {
  promise: Promise<LinkPreviewMetadata | null>;
  expiresAt: number;
  pending: boolean;
};

function metadataText(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || undefined
    : undefined;
}

export function createLinkPreviewClient(
  fetcher: typeof fetch = (...args) => fetch(...args),
) {
  const cache = new Map<string, CacheEntry>();
  const queue: Array<() => Promise<void>> = [];
  let activeRequests = 0;

  function drainQueue() {
    while (activeRequests < CONCURRENT_REQUESTS && queue.length) {
      const run = queue.shift()!;
      activeRequests += 1;
      void run().finally(() => {
        activeRequests -= 1;
        drainQueue();
      });
    }
  }

  async function request(url: string): Promise<LinkPreviewMetadata | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetcher(
        `/api/link-preview?url=${encodeURIComponent(url)}`,
        { signal: controller.signal, headers: { Accept: "application/json" } },
      );
      if (!response.ok) return null;
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("title" in data)) return null;
      const title = metadataText(data.title, 512);
      if (!title) return null;
      const image = "image" in data && typeof data.image === "string"
        ? normalizeLinkPreviewUrl(data.image) ?? undefined
        : undefined;
      return {
        url,
        title,
        description: "description" in data
          ? metadataText(data.description, 1024)
          : undefined,
        siteName: "siteName" in data
          ? metadataText(data.siteName, 200)
          : undefined,
        image,
      };
    } catch {
      // Offline, blocked, or unsupported pages remain ordinary working links.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return function getLinkPreview(value: string) {
    const url = normalizeLinkPreviewUrl(value);
    if (!url) return Promise.resolve(null);

    const existing = cache.get(url);
    if (existing && (existing.pending || existing.expiresAt > Date.now())) {
      cache.delete(url);
      cache.set(url, existing);
      return existing.promise;
    }
    cache.delete(url);

    if (cache.size >= CACHE_LIMIT) {
      const oldest = Array.from(cache).find(([, entry]) => !entry.pending);
      if (!oldest) return Promise.resolve(null);
      cache.delete(oldest[0]);
    }

    let resolve: (result: LinkPreviewMetadata | null) => void = () => {};
    const entry: CacheEntry = {
      promise: new Promise((complete) => { resolve = complete; }),
      expiresAt: Infinity,
      pending: true,
    };
    cache.set(url, entry);
    queue.push(async () => {
      const result = await request(url);
      entry.pending = false;
      entry.expiresAt = Date.now() + (result ? SUCCESS_TTL : FAILURE_TTL);
      resolve(result);
    });
    drainQueue();
    return entry.promise;
  };
}

export const getLinkPreview = createLinkPreviewClient();
