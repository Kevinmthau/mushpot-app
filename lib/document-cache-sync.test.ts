import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: async () => ({ from }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
});

describe("list refresh, offline editing, and reconnect", () => {
  it("retains confirmed share-only changes in a previously cached clean draft", async () => {
    const cache = await import("@/lib/doc-cache");
    const { DocumentDraftController } = await import("@/components/editor/document-draft-controller");
    const snapshot = {
      id: "document-a", owner: "owner-a", title: "Notes", content: "Body",
      updated_at: "2026-09-20T10:00:00.000Z", share_enabled: false, share_token: null,
      _dirty: false, _localUpdatedAt: Date.now(),
    };
    await cache.activateDocumentCacheForOwner(snapshot.owner);
    await cache.putCachedDocument(snapshot);
    const persist = vi.fn();
    const controller = new DocumentDraftController(snapshot, true, {
      cache: (document) => cache.putCachedDocument(document),
      persist,
    });

    controller.updateShareState(true, "first-token", "2026-09-20T11:00:00.000Z", snapshot);
    await controller.flushLatestDraft();
    expect(await cache.getCachedDocumentForOwner(snapshot.id, snapshot.owner)).toMatchObject({
      share_enabled: true, share_token: "first-token", _dirty: false,
      updated_at: "2026-09-20T11:00:00.000Z",
    });

    controller.updateShareState(true, "rotated-token", "2026-09-20T12:00:00.000Z", snapshot);
    await controller.flushLatestDraft();
    expect(await cache.getCachedDocumentForOwner(snapshot.id, snapshot.owner)).toMatchObject({
      share_enabled: true, share_token: "rotated-token", _dirty: false,
      updated_at: "2026-09-20T12:00:00.000Z",
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the body's old revision so reconnect cannot overwrite a newer remote body", async () => {
    const cache = await import("@/lib/doc-cache");
    const { loadEditorDocument } = await import("@/components/editor/use-editor-document");
    const { toEditorDocument } = await import("@/lib/documents");
    const { persistDocumentSnapshot } = await import("@/lib/document-sync");
    const snapshot = {
      id: "document-a", owner: "owner-a", title: "Original title", content: "Original body",
      updated_at: "2026-09-20T10:00:00.000Z", share_enabled: false, share_token: null,
    };
    const remote = { ...snapshot, title: "Remote title", content: "New remote body", updated_at: "2026-09-20T11:00:00.000Z" };
    const updateVersions: unknown[] = [];
    from.mockImplementation(() => {
      let changes: Partial<typeof remote> | undefined;
      const filters: Record<string, unknown> = {};
      const query = {
        update(value: Partial<typeof remote>) { changes = value; return query; },
        select() { return query; },
        eq(key: string, value: unknown) { filters[key] = value; return query; },
        async maybeSingle() {
          if (changes) updateVersions.push(filters.updated_at);
          if (Object.entries(filters).some(([key, value]) => remote[key as keyof typeof remote] !== value)) {
            return { data: null, error: null };
          }
          if (changes) Object.assign(remote, changes);
          return { data: { ...remote }, error: null };
        },
      };
      return query;
    });
    await cache.activateDocumentCacheForOwner(snapshot.owner);
    await cache.putCachedDocument(snapshot);
    await cache.syncDocumentList([{ id: remote.id, title: remote.title, updated_at: remote.updated_at }], snapshot.owner);
    const cached = await cache.getCachedDocumentForOwner(snapshot.id, snapshot.owner);
    const onResolved = vi.fn();
    await loadEditorDocument({
      isCurrent: () => true,
      loadCache: async () => ({ document: toEditorDocument(cached!), token: cache.getDocumentCacheWriteToken(snapshot.owner) }),
      loadRemote: async () => { throw new Error("Offline"); },
      onCache: vi.fn(),
      onResolved,
      reconcileRemote: async (document) => document,
    });
    const offlineDocument = onResolved.mock.calls[0][0].document;
    expect(offlineDocument).toMatchObject({ content: snapshot.content, updated_at: snapshot.updated_at });
    const draft = { ...offlineDocument, content: "Original body with offline edits", _dirty: true };
    await cache.putCachedDocument(draft);
    expect(await persistDocumentSnapshot(draft)).toMatchObject({ ok: false, conflict: true });
    expect(updateVersions).toEqual([snapshot.updated_at]);
    expect(remote.content).toBe("New remote body");
    expect(await cache.getCachedDocumentForOwner(snapshot.id, snapshot.owner)).toMatchObject({ content: draft.content, _dirty: true });
  });
});

it("never updates from an untrusted legacy revision and only confirms identical server content", async () => {
  const cache = await import("@/lib/doc-cache");
  const { persistDocumentSnapshot } = await import("@/lib/document-sync");
  const draft = {
    id: "legacy", owner: "owner-a", title: "Draft", content: "Offline content",
    updated_at: "2026-09-20T11:00:00.000Z", share_enabled: false, share_token: null,
    _dirty: true, _baseVersionUntrusted: true,
  };
  await cache.activateDocumentCacheForOwner(draft.owner);
  await cache.putCachedDocument(draft);
  const update = vi.fn();
  const maybeSingle = vi.fn().mockResolvedValue({ data: { ...draft, content: "New remote content" }, error: null });
  const query = { eq: () => query, maybeSingle };
  from.mockReturnValue({ update, select: () => query });
  expect(await persistDocumentSnapshot(draft)).toMatchObject({ ok: false, conflict: true });
  expect(update).not.toHaveBeenCalled();
  expect(await cache.getCachedDocumentForOwner(draft.id, draft.owner)).toMatchObject({
    content: draft.content, _dirty: true, _baseVersionUntrusted: true,
  });
  // A new persistence lifetime may discover this exact draft already exists remotely.
  vi.resetModules();
  const reloadedCache = await import("@/lib/doc-cache");
  await reloadedCache.activateDocumentCacheForOwner(draft.owner);
  const reloadedSync = await import("@/lib/document-sync");
  maybeSingle.mockResolvedValue({ data: { ...draft }, error: null });
  expect(await reloadedSync.persistDocumentSnapshot(draft)).toMatchObject({ ok: true, conflict: false });
  expect(update).not.toHaveBeenCalled();
  expect(await reloadedCache.getCachedDocumentForOwner(draft.id, draft.owner)).toMatchObject({
    _dirty: false, _baseVersionUntrusted: false,
  });
});
