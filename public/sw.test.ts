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

type ServiceWorkerContext = {
  caches: MemoryCaches;
  fetch: FetchMock;
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
  const self = {
    addEventListener: vi.fn(),
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

  return context as unknown as ServiceWorkerContext;
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
    const cache = await context.caches.open("mushpot-nav-v9");
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
    const cache = await context.caches.open("mushpot-nav-v9");
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
    const cache = await context.caches.open("mushpot-nav-v9");
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
    const cache = await context.caches.open("mushpot-nav-v9");
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
    const cache = await context.caches.open("mushpot-nav-v9");
    vi.spyOn(cache, "put").mockRejectedValueOnce(new Error("quota"));

    const response = await context.navigationNetworkFirst(
      new Request("https://mushpot.app/auth"),
      buildNavigationEvent(),
    );

    expect(await response.text()).toBe("auth shell");
  });
});
