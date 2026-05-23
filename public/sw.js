const STATIC_CACHE_NAME = "mushpot-static-v5";
const NAV_CACHE_NAME = "mushpot-nav-v8";

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

const PRIVATE_DOC_SHELL_LIMIT = 12;

function getNavigationCacheKey(request) {
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function putNavigationResponse(cache, cacheKey, response) {
  if (response.ok && !response.redirected) {
    await cache.put(cacheKey, response.clone());
  }
}

async function trimPrivateDocShells(cache) {
  const requests = await cache.keys();
  const docRequests = requests.filter((request) => {
    const pathname = new URL(request.url).pathname;
    return pathname.startsWith("/doc/");
  });

  if (docRequests.length <= PRIVATE_DOC_SHELL_LIMIT) {
    return;
  }

  await Promise.all(
    docRequests
      .slice(0, docRequests.length - PRIVATE_DOC_SHELL_LIMIT)
      .map((request) => cache.delete(request)),
  );
}

async function revalidateNavigation(request, cache, cacheKey) {
  const networkResponse = await fetch(request);
  await putNavigationResponse(cache, cacheKey, networkResponse);
  await trimPrivateDocShells(cache);
  return networkResponse;
}

/**
 * Private routes use cached App Router shells as containers while document data
 * comes from IndexedDB + Supabase on the client. Returning a warm shell
 * immediately removes a full HTML network roundtrip from mobile startup.
 */
async function navigationNetworkFirst(request, event) {
  const pathname = new URL(request.url).pathname;
  const allowNavigationCache =
    pathname === "/auth" || pathname.startsWith("/s/");
  const isPrivateRoute =
    pathname === "/" || pathname.startsWith("/doc/");

  const cacheName = (allowNavigationCache || isPrivateRoute) ? NAV_CACHE_NAME : null;
  const cache = cacheName ? await caches.open(cacheName) : null;
  const cacheKey = cache ? getNavigationCacheKey(request) : null;

  try {
    if (isPrivateRoute && cache) {
      const cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        event.waitUntil(
          revalidateNavigation(request, cache, cacheKey).catch(() => undefined),
        );
        return cachedResponse;
      }

      const networkResponse = await revalidateNavigation(request, cache, cacheKey);
      return networkResponse;
    }

    const networkResponse = await fetch(request);

    if (cache && cacheKey) {
      await putNavigationResponse(cache, cacheKey, networkResponse);
    }
    return networkResponse;
  } catch {
    if (cache) {
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

  event.waitUntil(caches.delete(NAV_CACHE_NAME));
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

  // Cache only full navigation shells here; App Router RSC/data payloads are
  // intentionally left to the browser/network path below.
  if (request.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(request, event));
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
