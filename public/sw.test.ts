import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn<FetchImplementation>>;

type NavigationEvent = {
  waitUntil: (promise: Promise<unknown>) => void;
};

type FetchEvent = {
  request: Request;
  respondWith: ReturnType<typeof vi.fn>;
};

type ActivateEvent = {
  waitUntil: (promise: Promise<unknown>) => void;
};

type ServiceWorkerMessageEvent = {
  data: unknown;
  waitUntil: (promise: Promise<unknown>) => void;
};

type ServiceWorkerContext = {
  activateHandler: (event: ActivateEvent) => void;
  caches: MemoryCaches;
  fetch: FetchMock;
  fetchHandler: (event: FetchEvent) => void;
  messageHandler: (event: ServiceWorkerMessageEvent) => void;
  navigationNetworkFirst: (
    request: Request,
    event?: NavigationEvent,
  ) => Promise<Response>;
};

function toCacheKey(input: RequestInfo | URL) {
  if (input instanceof Request) {
    return input.url;
  }

  return new URL(input.toString(), "https://mushpot.app").toString();
}

class MemoryCache {
  private responses = new Map<string, Response>();

  async match(input: RequestInfo | URL) {
    return this.responses.get(toCacheKey(input))?.clone();
  }

  async put(input: RequestInfo | URL, response: Response) {
    this.responses.set(toCacheKey(input), response.clone());
  }

  async delete(input: RequestInfo | URL) {
    return this.responses.delete(toCacheKey(input));
  }

  async keys() {
    return [...this.responses.keys()].map((url) => new Request(url));
  }
}

class MemoryCaches {
  private caches = new Map<string, MemoryCache>();

  async open(cacheName: string) {
    let cache = this.caches.get(cacheName);

    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(cacheName, cache);
    }

    return cache;
  }

  async match(input: RequestInfo | URL) {
    if (input.toString() === "/offline.html") {
      return new Response("offline", { status: 200 });
    }

    for (const cache of this.caches.values()) {
      const response = await cache.match(input);

      if (response) {
        return response;
      }
    }

    return undefined;
  }

  async keys() {
    return [...this.caches.keys()];
  }

  async delete(cacheName: string) {
    return this.caches.delete(cacheName);
  }
}

function loadServiceWorker(fetchImplementation: FetchImplementation): ServiceWorkerContext {
  const caches = new MemoryCaches();
  const fetchMock = vi.fn(fetchImplementation) as FetchMock;
  const script = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
  const eventListeners = new Map<string, Array<(event: never) => void>>();
  const self = {
    addEventListener: vi.fn(
      (eventName: string, listener: (event: never) => void) => {
        const listeners = eventListeners.get(eventName) ?? [];
        listeners.push(listener);
        eventListeners.set(eventName, listeners);
      },
    ),
    clients: {
      claim: vi.fn(() => Promise.resolve()),
    },
    location: {
      origin: "https://mushpot.app",
    },
    skipWaiting: vi.fn(),
  };
  const context = {
    caches,
    console,
    fetch: fetchMock,
    Promise,
    Request,
    Response,
    self,
    Set,
    URL,
  };

  vm.runInNewContext(script, context);

  const fetchHandler = eventListeners.get("fetch")?.[0];
  const activateHandler = eventListeners.get("activate")?.[0];
  const messageHandler = eventListeners.get("message")?.[0];
  if (!fetchHandler || !activateHandler || !messageHandler) {
    throw new Error("Service worker did not register required handlers.");
  }

  return {
    ...context,
    activateHandler: activateHandler as unknown as (event: ActivateEvent) => void,
    fetchHandler: fetchHandler as unknown as (event: FetchEvent) => void,
    messageHandler: messageHandler as unknown as (
      event: ServiceWorkerMessageEvent,
    ) => void,
  } as unknown as ServiceWorkerContext;
}

function buildNavigationEvent(): NavigationEvent {
  return {
    waitUntil: vi.fn(),
  };
}

describe("service worker private navigation", () => {
  it("uses the network response instead of a cached private shell", async () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(new Response("network shell", { status: 200 })),
    );
    const cache = await context.caches.open("mushpot-nav-v11");
    await cache.put(
      "https://mushpot.app/doc/abc",
      new Response("cached private shell", { status: 200 }),
    );

    const response = await context.navigationNetworkFirst(
      new Request("https://mushpot.app/doc/abc"),
      buildNavigationEvent(),
    );

    expect(await response.text()).toBe("network shell");
    expect(context.fetch).toHaveBeenCalledTimes(1);
    expect(
      await (
        await cache.match("https://mushpot.app/doc/abc")
      )?.text(),
    ).toBe("network shell");
  });

  it("returns the private network response when caching fails", async () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(new Response("network shell", { status: 200 })),
    );
    const cache = await context.caches.open("mushpot-nav-v11");
    vi.spyOn(cache, "put").mockRejectedValueOnce(new Error("quota"));

    const response = await context.navigationNetworkFirst(
      new Request("https://mushpot.app/doc/abc"),
      buildNavigationEvent(),
    );

    expect(await response.text()).toBe("network shell");
  });

  it("returns a private auth redirect when cache clearing fails", async () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "/auth?next=%2Fdoc%2Fabc" },
        }),
      ),
    );
    const cache = await context.caches.open("mushpot-nav-v11");
    await cache.put(
      "https://mushpot.app/doc/abc",
      new Response("cached private shell", { status: 200 }),
    );
    vi.spyOn(cache, "delete").mockRejectedValueOnce(new Error("storage"));

    const response = await context.navigationNetworkFirst(
      new Request("https://mushpot.app/doc/abc"),
      buildNavigationEvent(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/auth?next=%2Fdoc%2Fabc");
  });

  it("does not use a cached private shell when validation cannot complete", async () => {
    const context = loadServiceWorker(() => Promise.reject(new Error("offline")));
    const cache = await context.caches.open("mushpot-nav-v11");
    await cache.put(
      "https://mushpot.app/doc/abc",
      new Response("cached private shell", { status: 200 }),
    );

    const response = await context.navigationNetworkFirst(
      new Request("https://mushpot.app/doc/abc"),
      buildNavigationEvent(),
    );

    expect(await response.text()).toBe("offline");
  });
});

describe("service worker cacheable navigation", () => {
  it("returns the network response when navigation caching fails", async () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(new Response("auth shell", { status: 200 })),
    );
    const cache = await context.caches.open("mushpot-nav-v11");
    vi.spyOn(cache, "put").mockRejectedValueOnce(new Error("quota"));

    const response = await context.navigationNetworkFirst(
      new Request("https://mushpot.app/auth"),
      buildNavigationEvent(),
    );

    expect(await response.text()).toBe("auth shell");
  });
});

describe("service worker shared-document navigation", () => {
  it("does not cache a successful shared-document response", async () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(new Response("fresh shared document", { status: 200 })),
    );
    const cache = await context.caches.open("mushpot-nav-v11");

    const response = await context.navigationNetworkFirst(
      new Request("https://mushpot.app/s/doc-id/share-token"),
      buildNavigationEvent(),
    );

    expect(await response.text()).toBe("fresh shared document");
    expect(
      await cache.match("https://mushpot.app/s/doc-id/share-token"),
    ).toBeUndefined();
  });

  it("does not serve a previously cached shared document while offline", async () => {
    const context = loadServiceWorker(() => Promise.reject(new Error("offline")));
    const cache = await context.caches.open("mushpot-nav-v11");
    await cache.put(
      "https://mushpot.app/s/doc-id/share-token",
      new Response("revoked shared document", { status: 200 }),
    );

    const response = await context.navigationNetworkFirst(
      new Request("https://mushpot.app/s/doc-id/share-token"),
      buildNavigationEvent(),
    );

    expect(await response.text()).toBe("offline");
  });
});

describe("service worker sensitive-route bypass", () => {
  function dispatchFetch(
    context: ServiceWorkerContext,
    pathname: string,
    options: { destination?: string; mode?: string } = {},
  ) {
    const request = {
      destination: options.destination ?? "",
      method: "GET",
      mode: options.mode ?? "cors",
      url: `https://mushpot.app${pathname}`,
    } as Request;
    const event: FetchEvent = {
      request,
      respondWith: vi.fn(),
    };

    context.fetchHandler(event);
    return event;
  }

  it.each([
    ["shared navigation", "/s/doc-id/share-token", { mode: "navigate" }],
    [
      "shared Open Graph image",
      "/s/doc-id/share-token/opengraph-image",
      { destination: "image" },
    ],
    [
      "shared document media",
      "/s/doc-id/share-token/m/document-images/owner/doc/file.png",
      { destination: "image" },
    ],
    ["authenticated image", "/m/document-images/owner/doc/file.png", { destination: "image" }],
    ["authenticated video", "/m/document-videos/owner/doc/file.mp4", { destination: "video" }],
  ])("leaves %s entirely to the network", (_label, pathname, options) => {
    const context = loadServiceWorker(() =>
      Promise.resolve(new Response("network", { status: 200 })),
    );

    const event = dispatchFetch(context, pathname, options);

    expect(event.respondWith).not.toHaveBeenCalled();
    expect(context.fetch).not.toHaveBeenCalled();
  });

  it("still handles immutable Next.js assets", () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(new Response("network", { status: 200 })),
    );

    const event = dispatchFetch(context, "/_next/static/chunks/app.js", {
      destination: "script",
    });

    expect(event.respondWith).toHaveBeenCalledTimes(1);
  });

  it.each(["/", "/doc/private-document"])(
    "does not cache a private route requested as an image: %s",
    (pathname) => {
      const context = loadServiceWorker(() =>
        Promise.resolve(new Response("private route", { status: 200 })),
      );

      const event = dispatchFetch(context, pathname, {
        destination: "image",
      });

      expect(event.respondWith).not.toHaveBeenCalled();
      expect(context.fetch).not.toHaveBeenCalled();
    },
  );

  it("still caches a known public icon", () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(new Response("icon", { status: 200 })),
    );

    const event = dispatchFetch(context, "/icons/icon-192.png", {
      destination: "image",
    });

    expect(event.respondWith).toHaveBeenCalledTimes(1);
  });

  it("does not retain a no-store response for a public asset path", async () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(
        new Response("uncacheable", {
          status: 200,
          headers: { "Cache-Control": "private, no-store" },
        }),
      ),
    );

    const event = dispatchFetch(context, "/icons/icon-192.png", {
      destination: "image",
    });
    const responsePromise = event.respondWith.mock.calls[0]?.[0] as
      | Promise<Response>
      | undefined;

    expect(responsePromise).toBeDefined();
    await responsePromise;

    const cache = await context.caches.open("mushpot-static-v8");
    expect(
      await cache.match("https://mushpot.app/icons/icon-192.png"),
    ).toBeUndefined();
  });

  it("purges cache generations that predate the sensitive-route bypass", async () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(new Response("network", { status: 200 })),
    );
    await context.caches.open("mushpot-static-v6");
    await context.caches.open("mushpot-nav-v10");
    await context.caches.open("mushpot-static-v7");
    await context.caches.open("mushpot-static-v8");
    await context.caches.open("mushpot-nav-v11");
    let activation: Promise<unknown> | undefined;

    context.activateHandler({
      waitUntil: (promise) => {
        activation = promise;
      },
    });
    await activation;

    expect(await context.caches.keys()).toEqual([
      "mushpot-static-v8",
      "mushpot-nav-v11",
    ]);
  });

  it("clears private and legacy caches while preserving current offline assets", async () => {
    const context = loadServiceWorker(() =>
      Promise.resolve(new Response("network", { status: 200 })),
    );
    const currentStaticCache = await context.caches.open("mushpot-static-v8");
    await currentStaticCache.put(
      "https://mushpot.app/offline.html",
      new Response("current offline fallback", { status: 200 }),
    );
    await context.caches.open("mushpot-static-v7");
    await context.caches.open("mushpot-nav-v11");
    await context.caches.open("unrelated-cache");
    let cleanup: Promise<unknown> | undefined;

    context.messageHandler({
      data: { type: "CLEAR_PRIVATE_NAV_CACHE" },
      waitUntil: (promise) => {
        cleanup = promise;
      },
    });
    await cleanup;

    expect(await context.caches.keys()).toEqual([
      "mushpot-static-v8",
      "unrelated-cache",
    ]);
    expect(
      await (
        await currentStaticCache.match("https://mushpot.app/offline.html")
      )?.text(),
    ).toBe("current offline fallback");
  });
});
