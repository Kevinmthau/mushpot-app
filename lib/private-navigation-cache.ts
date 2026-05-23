export async function clearPrivateNavigationCache() {
  if (typeof window === "undefined" || !("caches" in window)) {
    return;
  }

  try {
    const cacheNames = await window.caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith("mushpot-nav-"))
        .map((cacheName) => window.caches.delete(cacheName)),
    );

    navigator.serviceWorker?.controller?.postMessage({
      type: "CLEAR_PRIVATE_NAV_CACHE",
    });
  } catch {
    // Best-effort cache cleanup on sign-out.
  }
}
