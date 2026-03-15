const STATIC_CACHE_NAME = "mushpot-static-v3";
const RUNTIME_CACHE_NAME = "mushpot-runtime-v1";
const NAV_CACHE_NAME = "mushpot-nav-v2";

const STATIC_FILES = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/offline.html",
];

// Known cache names – anything else gets cleaned up on activate
const KNOWN_CACHES = new Set([STATIC_CACHE_NAME, RUNTIME_CACHE_NAME, NAV_CACHE_NAME]);

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
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  return cachedResponse || (await networkResponsePromise) || Response.error();
}

/**
 * Stale-while-revalidate for navigation: return cached page immediately for
 * instant loads, then fetch a fresh copy in the background for next time.
 * Falls back to offline page if both cache and network fail.
 */
async function navigationStaleWhileRevalidate(request) {
  const cache = await caches.open(NAV_CACHE_NAME);
  const cachedResponse = await cache.match(request);

  const networkResponsePromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  if (cachedResponse) {
    // Serve cached immediately; network fetch updates cache in background
    return cachedResponse;
  }

  // No cache — wait for network
  const networkResponse = await networkResponsePromise;
  if (networkResponse) {
    return networkResponse;
  }

  // Last resort: offline fallback page
  const fallback = await caches.match("/offline.html");
  return fallback || Response.error();
}

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

  // Navigation requests: stale-while-revalidate for instant loads
  if (request.mode === "navigate") {
    event.respondWith(navigationStaleWhileRevalidate(request));
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

  // Other static assets: stale-while-revalidate
  const isStaticAsset =
    request.destination === "style" ||
    request.destination === "script" ||
    request.destination === "worker" ||
    request.destination === "font" ||
    request.destination === "image";

  if (isStaticAsset) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE_NAME));
    return;
  }

  // Next.js RSC/data fetches: stale-while-revalidate for instant page transitions
  if (
    url.pathname.startsWith("/_next/data/") ||
    request.headers.get("RSC") === "1" ||
    request.headers.get("Next-Router-State-Tree")
  ) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE_NAME));
  }
});
