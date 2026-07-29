const STATIC_CACHE_NAME = "mushpot-static-v8";
const NAV_CACHE_NAME = "mushpot-nav-v12";

const STATIC_FILES = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/offline.html",
];

// Known cache names – anything else gets cleaned up on activate
const KNOWN_CACHES = new Set([STATIC_CACHE_NAME, NAV_CACHE_NAME]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_FILES))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (!KNOWN_CACHES.has(key)) {
              return caches.delete(key);
            }
            return Promise.resolve(false);
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------------------
// Cache strategies
// ---------------------------------------------------------------------------

/**
 * Stale-while-revalidate: return cached immediately, fetch in background.
 * Used for static assets (scripts, styles, fonts, images).
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);

  const networkResponsePromise = fetch(request)
    .then((response) => {
      const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
      if (
        response.ok &&
        !cacheControl.includes("no-store") &&
        !cacheControl.includes("private")
      ) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  return cachedResponse || (await networkResponsePromise) || Response.error();
}

function shouldBypassServiceWorkerCache(pathname) {
  return (
    pathname === "/s" ||
    pathname.startsWith("/s/") ||
    pathname === "/m" ||
    pathname.startsWith("/m/")
  );
}

function isKnownPublicAssetPath(pathname) {
  return (
    pathname === "/icon.png" ||
    pathname === "/manifest.webmanifest" ||
    pathname.startsWith("/icons/")
  );
}

function getNavigationCacheKey(request) {
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function putNavigationResponse(cache, cacheKey, response) {
  try {
    if (response.ok && !response.redirected) {
      await cache.put(cacheKey, response.clone());
    }
  } catch {
    // Navigation cache writes are best-effort; never hide a network response.
  }
}

async function navigationNetworkFirst(request) {
  const pathname = new URL(request.url).pathname;
  const allowNavigationCache = pathname === "/auth";
  const cacheName = allowNavigationCache ? NAV_CACHE_NAME : null;
  const cache = cacheName ? await caches.open(cacheName) : null;
  const cacheKey = cache ? getNavigationCacheKey(request) : null;

  try {
    const networkResponse = await fetch(request);

    if (cache && cacheKey) {
      await putNavigationResponse(cache, cacheKey, networkResponse);
    }
    return networkResponse;
  } catch {
    if (cache && cacheKey) {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    const fallback = await caches.match("/offline.html");
    return fallback || Response.error();
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CLEAR_PRIVATE_NAV_CACHE") {
    return;
  }

  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith("mushpot-nav-") ||
              (key.startsWith("mushpot-static-") &&
                key !== STATIC_CACHE_NAME),
          )
          .map((key) => caches.delete(key)),
      ),
    ),
  );
});

// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Shared documents and authenticated media can be revoked. Leave every
  // request under these route families entirely to the browser/network so
  // neither navigation nor destination-based asset strategies can retain it.
  if (shouldBypassServiceWorkerCache(url.pathname)) {
    return;
  }

  // Cache only full navigation shells here; App Router RSC/data payloads are
  // intentionally left to the browser/network path below.
  if (request.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(request));
    return;
  }

  // Next.js hashed static assets: cache-first (they're immutable)
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(STATIC_CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Only explicitly public assets may use the general static cache. Request
  // destinations are attacker-influenced through embedded Markdown URLs and
  // are not sufficient evidence that a same-origin response is public.
  if (isKnownPublicAssetPath(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE_NAME));
    return;
  }

  // Do not cache App Router RSC/data responses in the service worker.
  // Those payloads are deployment-coupled and unsafe to reuse after updates.
});
