import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CachedDocument } from "@/lib/doc-cache";

const mock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: async () => ({ from: mock.from }),
}));

const draft: CachedDocument = {
  id: "doc",
  owner: "owner",
  title: "Title",
  content: "Offline text",
  updated_at: "2026-09-20T10:00:00Z",
  share_enabled: false,
  share_token: null,
  _dirty: true,
  _localUpdatedAt: 10,
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => vi.unstubAllGlobals());

describe("foreground and background persistence with IndexedDB", () => {
  it("serializes overlap and leaves the newest text clean in both database and cache", async () => {
    const cache = await import("@/lib/doc-cache");
    const sync = await import("@/lib/document-sync");
    const { createDocumentWriteSession } =
      await import("@/lib/document-write-coordinator");
    const session = createDocumentWriteSession("owner");
    await cache.activateDocumentCacheForOwner("owner");
    await cache.putCachedDocument(draft);
    let remote = { ...draft, _dirty: false };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const writes: Array<{ content: string; base: string }> = [];
    mock.from.mockImplementation(() => ({
      update: (body: { title: string; content: string }) => {
        const filters: Record<string, string> = {};
        const query = {
          eq(key: string, value: string) {
            filters[key] = value;
            return query;
          },
          select() {
            return query;
          },
          async maybeSingle() {
            writes.push({ content: body.content, base: filters.updated_at });
            if (writes.length === 1) {
              startedFirst();
              await firstGate;
            }
            if (filters.updated_at !== remote.updated_at)
              return { data: null, error: null };
            remote = {
              ...remote,
              ...body,
              updated_at: `2026-09-20T1${writes.length}:00:00Z`,
            };
            return { data: remote, error: null };
          },
        };
        return query;
      },
    }));
    const background = sync.flushDirtyDocuments("owner", session);
    await firstStarted;
    const latest = {
      ...draft,
      content: "Latest editor text",
      _localUpdatedAt: 11,
    };
    await cache.putCachedDocument(latest);
    const foreground = sync.persistDocumentSnapshot(
      latest,
      cache.getDocumentCacheWriteToken("owner"),
      session,
    );
    releaseFirst();
    await Promise.all([background, foreground]);
    expect(writes).toEqual([
      { content: "Offline text", base: "2026-09-20T10:00:00Z" },
      { content: "Latest editor text", base: "2026-09-20T11:00:00Z" },
    ]);
    expect(remote.content).toBe("Latest editor text");
    expect(await cache.getCachedDocumentForOwner("doc", "owner")).toMatchObject(
      {
        content: "Latest editor text",
        updated_at: "2026-09-20T12:00:00Z",
        _dirty: false,
      },
    );
  });

  it("fences cache writes and queued requests when the cache generation is revoked", async () => {
    const cache = await import("@/lib/doc-cache");
    const sync = await import("@/lib/document-sync");
    await cache.activateDocumentCacheForOwner("owner");
    await cache.putCachedDocument(draft);
    let release!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const query = {
      eq: () => query,
      select: () => query,
      maybeSingle: () => {
        started();
        return response;
      },
    };
    mock.from.mockReturnValue({ update: () => query });
    const token = cache.getDocumentCacheWriteToken("owner");
    const running = sync.persistDocumentSnapshot(draft, token);
    await began;
    const queued = sync.persistDocumentSnapshot(
      { ...draft, content: "Queued text", _localUpdatedAt: 11 },
      token,
    );
    await cache.deactivateDocumentCacheForOwner("owner");
    release({
      data: { ...draft, updated_at: "2026-09-20T11:00:00Z" },
      error: null,
    });
    expect((await running).status).toBe("cancelled");
    expect((await queued).status).toBe("cancelled");
    expect(mock.from).toHaveBeenCalledOnce();
    await cache.activateDocumentCacheForOwner("owner");
    expect(await cache.getCachedDocumentForOwner("doc", "owner")).toMatchObject(
      { content: "Offline text", updated_at: draft.updated_at, _dirty: true },
    );
  });
});
