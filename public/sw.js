const STATIC_CACHE_NAME = "mushpot-static-v5";
const NAV_CACHE_NAME = "mushpot-nav-v7";

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
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  return cachedResponse || (await networkResponsePromise) || Response.error();
}

/**
 * Network-first for navigation with a fast timeout for private routes.
 *
 * Private routes (/, /doc/*) use the App Router shell as a container while
 * real data comes from IndexedDB + Supabase on the client.  On slow mobile
 * connections the network roundtrip for the HTML shell is the main bottleneck,
 * so we race the network against a 2 s timeout and fall back to a cached
 * shell if the network is too slow.  The client-side code will still fetch
 * fresh data independently.
 */
const NAV_TIMEOUT_MS = 2000;

async function navigationNetworkFirst(request) {
  const pathname = new URL(request.url).pathname;
  const allowNavigationCache =
    pathname === "/auth" || pathname.startsWith("/s/");
  const isPrivateRoute =
    pathname === "/" || pathname.startsWith("/doc/");

  const cacheName = (allowNavigationCache || isPrivateRoute) ? NAV_CACHE_NAME : null;
  const cache = cacheName ? await caches.open(cacheName) : null;

  try {
    let networkResponse;

    if (isPrivateRoute && cache) {
      // Race the network against a timeout so cached shells load instantly
      // on slow mobile connections.
      const cachedResponse = await cache.match(request);

      if (cachedResponse) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS);

        try {
          networkResponse = await fetch(request, { signal: controller.signal });
          clearTimeout(timeout);
        } catch {
          clearTimeout(timeout);
          // Network too slow or offline – serve cached shell immediately
          return cachedResponse;
        }
      } else {
        networkResponse = await fetch(request);
      }
    } else {
      networkResponse = await fetch(request);
    }

    if (cache && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    if (cache) {
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

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

  // Keep navigation network-first so route payloads stay in sync with the
  // current deployment.
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
