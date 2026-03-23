const STATIC_CACHE_NAME = "mushpot-static-v5";
const NAV_CACHE_NAME = "mushpot-nav-v5";
const NAVIGATION_NETWORK_TIMEOUT_MS = 800;

const STATIC_FILES = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/offline.html",
];
const HOME_NAVIGATION_REQUEST = new Request("/", {
  credentials: "same-origin",
  headers: {
    Accept: "text/html",
  },
});

// Known cache names – anything else gets cleaned up on activate
const KNOWN_CACHES = new Set([STATIC_CACHE_NAME, NAV_CACHE_NAME]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .open(STATIC_CACHE_NAME)
        .then((cache) => cache.addAll(STATIC_FILES))
        .catch(() => undefined),
      caches
        .open(NAV_CACHE_NAME)
        .then((cache) => cache.add(HOME_NAVIGATION_REQUEST))
        .catch(() => undefined),
    ]),
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
 * Network-preferred for navigation with a short stale-shell timeout.
 * This keeps launches responsive while still refreshing the cached shell
 * in the background once the network responds.
 */
async function fetchAndCacheNavigation(request, cache) {
  const response = await fetch(request);

  if (response.ok) {
    await cache.put(request, response.clone());
  }

  return response;
}

async function navigationNetworkFirst(event) {
  const request = event.request;
  const cache = await caches.open(NAV_CACHE_NAME);
  const cachedResponse = await cache.match(request);
  const networkResponsePromise = fetchAndCacheNavigation(request, cache);

  if (cachedResponse) {
    event.waitUntil(networkResponsePromise.catch(() => undefined));

    try {
      return await Promise.race([
        networkResponsePromise,
        new Promise((resolve) => {
          setTimeout(() => resolve(cachedResponse), NAVIGATION_NETWORK_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return cachedResponse;
    }
  }

  try {
    return await networkResponsePromise;
  } catch {
    const fallback = await caches.match("/offline.html");
    return fallback || Response.error();
  }
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

  // Prefer fresh navigations, but fall back quickly to the cached shell if
  // the network is slow on app launch.
  if (request.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(event));
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

  // Do not cache App Router RSC/data responses in the service worker.
  // Those payloads are deployment-coupled and unsafe to reuse after updates.
});
