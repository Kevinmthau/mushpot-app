import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CachedDocument } from "@/lib/doc-cache";

const OWNER = "owner-a";
const row = (id: string, title = id, updated_at = "2026-10-02T12:00:00Z") =>
  ({ id, title, updated_at });
const document = (id: string, overrides: Partial<CachedDocument> = {}): CachedDocument => ({
  ...row(id), owner: OWNER, content: "Private body", share_enabled: false,
  share_token: null, ...overrides,
});

async function setup() {
  const cache = await import("@/lib/doc-cache");
  const { createDocumentWriteSession } = await import("@/lib/document-write-coordinator");
  const { createDocumentListSession } = await import("@/lib/document-list-session");
  const events = await import("@/lib/document-cache-events");
  await cache.activateDocumentCacheForOwner(OWNER);
  const token = cache.getDocumentCacheWriteToken(OWNER)!;
  const writer = createDocumentWriteSession(OWNER);
  const list = createDocumentListSession(writer);
  list.observe();
  return { cache, createDocumentListSession, createDocumentWriteSession, events, token, writer, list };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});

describe("session document list metadata", () => {
  it("tracks committed local title/sort changes and retains no document bodies", async () => {
    const { cache, list, token } = await setup();
    list.publishCacheRead([row("first"), row("second", "Second", "2026-10-02T11:00:00Z")], token, 0);
    await cache.putCachedDocument(document("second", {
      title: "Unsaved title", _dirty: true, updated_at: "2026-10-02T13:00:00Z",
    }), token);
    expect(list.getSnapshot()).toEqual([
      row("second", "Unsaved title", "2026-10-02T13:00:00Z"), row("first"),
    ]);
    expect(list.getServerSnapshot()).toBeNull();
    expect(list.getSnapshot()![0]).not.toHaveProperty("content");
    await cache.putCachedDocument(document("second", {
      title: "Saved title", updated_at: "2026-10-02T14:00:00Z",
      content: "Private body", _dirty: false,
    }), token);
    // A different clean title cannot acknowledge the still-dirty snapshot.
    expect(list.getSnapshot()![0].title).toBe("Unsaved title");
    list.retire();
  });

  it("does not let a slow cache read or stale revalidation undo a create/delete", async () => {
    const { cache, list, token } = await setup();
    await cache.putCachedDocument(document("deleted"), token);
    const stale = await cache.getCachedDocumentListForOwner(OWNER, token);
    list.publishCacheRead(stale, token, list.captureRevision());
    const finishLoad = list.beginLoad();
    const readRevision = list.captureRevision();
    await cache.putCachedDocument(document("created", {
      updated_at: "2026-10-02T14:00:00Z",
    }), token);
    await cache.deleteCachedDocument("deleted", OWNER, token);
    list.publishCacheRead(stale, token, readRevision);
    expect(list.getSnapshot()).toEqual([row("created", "created", "2026-10-02T14:00:00Z")]);
    // Current durable sync may remove a clean row absent from an earlier query;
    // the session's newer committed create must remain visible on return.
    await cache.syncDocumentList(stale, OWNER, token);
    expect(list.getSnapshot()).toEqual([row("created", "created", "2026-10-02T14:00:00Z")]);
    list.publishRemoteFallback(stale);
    expect(list.getSnapshot()).toEqual([row("created", "created", "2026-10-02T14:00:00Z")]);
    finishLoad();
    list.retire();
  });

  it("keeps dirty titles through reconciliation and a later cache-unavailable fallback", async () => {
    const { cache, list, token } = await setup();
    await cache.putCachedDocument(document("draft", {
      title: "Unsaved title", _dirty: true, _localUpdatedAt: 123,
    }), token);
    await cache.syncDocumentList([row("draft", "Old remote title", "2026-10-02T13:00:00Z")], OWNER, token);
    expect(list.getSnapshot()![0]).toEqual(row("draft", "Unsaved title", "2026-10-02T13:00:00Z"));
    list.publishRemoteFallback([row("draft", "Old remote title", "2026-10-02T13:30:00Z")]);
    expect(list.getSnapshot()![0]).toEqual(row("draft", "Unsaved title", "2026-10-02T13:30:00Z"));
    await cache.putCachedDocument(document("draft", {
      title: "Unsaved title", _dirty: false, _localUpdatedAt: 123,
      updated_at: "2026-10-02T14:00:00Z",
    }), token);
    await cache.syncDocumentList([row("draft", "Unsaved title", "2026-10-02T14:00:00Z")], OWNER, token);
    list.publishRemoteFallback([row("draft", "Newer remote title", "2026-10-02T15:00:00Z")]);
    expect(list.getSnapshot()![0].title).toBe("Newer remote title");
    list.retire();
  });

  it("invalidates synchronously and rejects late same-owner generations and retired writers", async () => {
    const { cache, list, token, events, createDocumentListSession, createDocumentWriteSession } = await setup();
    list.publishCacheRead([row("private")], token, 0);
    const deactivation = cache.deactivateDocumentCacheForOwner(OWNER);
    expect(list.active).toBe(false);
    expect(list.getSnapshot()).toBeNull();
    await deactivation;
    await cache.activateDocumentCacheForOwner(OWNER);
    const currentToken = cache.getDocumentCacheWriteToken(OWNER)!;
    expect(currentToken.generation).not.toBe(token.generation);
    const writer = createDocumentWriteSession(OWNER);
    const replacement = createDocumentListSession(writer);
    replacement.observe();
    events.announceDocumentCacheChange({ type: "replace", token, documents: [row("old")] });
    expect(replacement.getSnapshot()).toBeNull();
    replacement.publishCacheRead([row("current")], currentToken, replacement.captureRevision());
    events.announceDocumentCacheChange({ type: "replace", token, documents: [row("old")] });
    events.announceDocumentCacheChange({
      type: "replace", token: { owner: "owner-b", generation: currentToken.generation },
      documents: [row("other-owner")],
    });
    expect(replacement.getSnapshot()).toEqual([row("current")]);
    writer.deactivate();
    events.announceDocumentCacheChange({ type: "replace", token: currentToken, documents: [row("late")] });
    expect(replacement.getSnapshot()).toBeNull();
    replacement.retire();
  });

  it("retains confirmed server creates/clones/deletes when IndexedDB cannot update", async () => {
    const { list, token } = await setup();
    list.publishCacheRead([row("deleted")], token, list.captureRevision());
    list.confirmUpsert(OWNER, row("created"));
    list.confirmUpsert(OWNER, row("clone", "Cloned", "2026-10-02T14:00:00Z"));
    list.confirmDeletion(OWNER, "deleted");
    list.publishRemoteFallback([row("deleted")]);
    expect(list.getSnapshot()).toEqual([
      row("clone", "Cloned", "2026-10-02T14:00:00Z"), row("created"),
    ]);
    list.confirmUpsert("other-owner", row("private"));
    expect(list.getSnapshot()).toHaveLength(2);
    list.retire();
    list.confirmUpsert(OWNER, row("late"));
    expect(list.getSnapshot()).toBeNull();
  });

  it("preserves unacknowledged server confirmations over a later stale nonempty cache read", async () => {
    const { list, token } = await setup();
    list.publishCacheRead([row("old")], token, list.captureRevision());
    const created = row("created", "New document", "2026-10-02T13:00:00Z");
    list.confirmUpsert(OWNER, created);
    list.publishCacheRead([row("old")], token, list.captureRevision());
    expect(list.getSnapshot()).toEqual([created, row("old")]);
    const edited = row("old", "Confirmed title", "2026-10-02T14:00:00Z");
    list.confirmUpsert(OWNER, edited);
    list.publishCacheRead([row("old")], token, list.captureRevision());
    expect(list.getSnapshot()).toEqual([edited, created]);
    list.retire();
  });

  it("accepts newer clean remote metadata and advances the confirmation journal", async () => {
    const { list, token } = await setup();
    list.publishCacheRead([row("doc")], token, list.captureRevision());
    const confirmed = row("doc", "Confirmed title", "2026-10-02T13:00:00Z");
    list.confirmUpsert(OWNER, confirmed);
    list.publishRemoteFallback([row("doc", "Older query", "2026-10-02T12:30:00Z")]);
    expect(list.getSnapshot()).toEqual([confirmed]);
    const newer = row("doc", "Newer remote title", "2026-10-02T14:00:00Z");
    list.publishRemoteFallback([newer]);
    expect(list.getSnapshot()).toEqual([newer]);
    list.publishRemoteFallback([confirmed]);
    list.publishCacheRead([confirmed], token, list.captureRevision());
    expect(list.getSnapshot()).toEqual([newer]);
    list.retire();
  });

  it("retains a clean create omitted by a fallback query that began before confirmation", async () => {
    const { list, token } = await setup();
    list.publishCacheRead([row("old")], token, list.captureRevision());
    const finishLoad = list.beginLoad();
    const created = row("created", "Created", "2026-10-02T13:00:00Z");
    list.confirmUpsert(OWNER, created);
    list.publishRemoteFallback([row("old")]);
    expect(list.getSnapshot()).toEqual([created, row("old")]);
    finishLoad();
    list.retire();
  });

  it("removes a clean confirmation omitted by a fallback query begun after confirmation", async () => {
    const { list, token } = await setup();
    list.publishCacheRead([row("old")], token, list.captureRevision());
    const created = row("created", "Created", "2026-10-02T13:00:00Z");
    list.confirmUpsert(OWNER, created);
    const finishLoad = list.beginLoad();
    list.publishRemoteFallback([row("old")]);
    expect(list.getSnapshot()).toEqual([row("old")]);
    list.publishCacheRead([row("old"), created], token, list.captureRevision());
    expect(list.getSnapshot()).toEqual([row("old")]);
    finishLoad();
    list.retire();
  });

  it("notifies only after authorized durable writes commit, including create/clone/delete/list sync", async () => {
    const { cache, events, token, list } = await setup();
    const observed: string[] = [];
    const unsubscribe = events.subscribeToDocumentCacheChanges((event) => observed.push(event.type));
    expect(await cache.putCachedDocument(document("created"), token, () => false)).toBe(false);
    expect(observed).toEqual([]);
    await cache.putCachedDocument(document("created"), token);
    await cache.putCachedDocument(document("clone"), token);
    await cache.syncDocumentList([row("created"), row("clone")], OWNER, token);
    await cache.deleteCachedDocument("created", OWNER, token);
    expect(await cache.putCachedDocument(document("created"), token)).toBe(false);
    expect(observed).toEqual(["upsert", "upsert", "replace", "delete"]);
    expect(list.getSnapshot()).toEqual([row("clone")]);
    unsubscribe();
    list.retire();
  });
});
