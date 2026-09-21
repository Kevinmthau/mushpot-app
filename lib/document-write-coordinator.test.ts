import { describe, expect, it, vi } from "vitest";

import {
  createDocumentWriteCoordinator,
  createDocumentWriteSession,
} from "@/lib/document-write-coordinator";
import type {
  PersistableDocumentSnapshot,
  PersistDocumentResult,
  SavedDocumentResult,
} from "@/lib/document-sync";

const base: PersistableDocumentSnapshot = {
  id: "doc",
  owner: "owner",
  title: "Title",
  content: "Draft",
  updated_at: "v1",
  share_enabled: false,
  share_token: null,
  _localUpdatedAt: 10,
};
const saved = (version: string): SavedDocumentResult => ({
  status: "saved",
  confirmedSnapshot: { ...base, updated_at: version },
  cacheUpdated: true,
  persistedTitle: "Title",
  updatedAt: version,
});
const conflict: PersistDocumentResult = {
  status: "conflict",
  cacheUpdated: false,
  persistedTitle: "Title",
  updatedAt: "another-device-version",
};

function setup() {
  const persist =
    vi.fn<
      (snapshot: PersistableDocumentSnapshot) => Promise<PersistDocumentResult>
    >();
  const session = createDocumentWriteSession("owner");
  const scope = { session, cacheWriteToken: { owner: "owner", generation: 1 } };
  const confirmCache = vi.fn(
    async (_snapshot: PersistableDocumentSnapshot, result: SavedDocumentResult) =>
      result,
  );
  const coordinator = createDocumentWriteCoordinator({
    confirmCache,
    persist,
    isCurrent: (_owner, scope) => scope.session?.active === true,
  });
  return { coordinator, confirmCache, persist, scope, session };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("document write coordinator", () => {
  it("serializes background and foreground saves, rebasing only on its confirmed write", async () => {
    const { coordinator, persist, scope } = setup();
    const first = deferred<PersistDocumentResult>();
    persist
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(saved("v3"));
    const background = coordinator.enqueue(base, scope);
    const foreground = coordinator.enqueue(
      { ...base, content: "Newer typing", _localUpdatedAt: 11 },
      scope,
    );
    await Promise.resolve();
    expect(persist).toHaveBeenCalledOnce();
    first.resolve(saved("v2"));
    await Promise.all([background, foreground]);
    expect(persist).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: "Newer typing", updated_at: "v2" }),
      scope,
    );
  });

  it("coalesces identical overlapping snapshots and rejects a stale background snapshot", async () => {
    const { coordinator, persist, scope } = setup();
    persist.mockResolvedValue(saved("v2"));
    const current = { ...base, content: "Newest", _localUpdatedAt: 12 };
    await Promise.all([
      coordinator.enqueue(current, scope),
      coordinator.enqueue(current, scope),
    ]);
    const stale = await coordinator.enqueue(base, scope);
    expect(persist).toHaveBeenCalledOnce();
    expect(stale.status).toBe("superseded");
  });

  it("does not retry or adopt the remote timestamp after a conflict", async () => {
    const { coordinator, persist, scope } = setup();
    persist.mockResolvedValue(conflict);
    await coordinator.enqueue(base, scope);
    const next = await coordinator.enqueue(
      { ...base, content: "More local text", _localUpdatedAt: 20 },
      scope,
    );
    expect(next.status).toBe("conflict");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("preserves a reverted revision when an intermediate background draft arrives late", async () => {
    const { coordinator, persist, scope } = setup();
    persist.mockResolvedValue(saved("v2"));
    await coordinator.enqueue(base, scope);

    // The user changes the body, then returns to the saved body. Confirming
    // that later revision must supersede a delayed read of the interim edit.
    await coordinator.enqueue({ ...base, _localUpdatedAt: 12 }, scope);
    const stale = await coordinator.enqueue(
      { ...base, content: "Intermediate edit", _localUpdatedAt: 11 },
      scope,
    );

    expect(stale.status).toBe("superseded");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("does not lower the confirmed revision when an older duplicate arrives", async () => {
    const { coordinator, confirmCache, persist, scope } = setup();
    const latest = { ...base, updated_at: "v2", _localUpdatedAt: 12 };
    persist.mockResolvedValue({ ...saved("v2"), confirmedSnapshot: latest });
    await coordinator.enqueue({ ...base, _localUpdatedAt: 12 }, scope);
    const duplicate = await coordinator.enqueue(base, scope);
    expect(duplicate).toMatchObject({
      status: "saved",
      confirmedSnapshot: { _localUpdatedAt: 12 },
    });
    expect(confirmCache).toHaveBeenCalledWith(
      expect.objectContaining({ _localUpdatedAt: 12 }),
      expect.anything(),
      scope,
    );

    const stale = await coordinator.enqueue(
      { ...base, content: "Intermediate edit", _localUpdatedAt: 11 },
      scope,
    );

    expect(stale.status).toBe("superseded");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("accepts a freshly loaded version after a conflict without reviving older queued baselines", async () => {
    const { coordinator, persist, scope } = setup();
    persist
      .mockResolvedValueOnce(saved("v2"))
      .mockResolvedValueOnce(conflict)
      .mockResolvedValueOnce(saved("v4"));
    await coordinator.enqueue(base, scope);
    await coordinator.enqueue(
      { ...base, content: "Conflicting text", _localUpdatedAt: 11 },
      scope,
    );
    await coordinator.enqueue(
      { ...base, content: "Queued on original baseline", _localUpdatedAt: 12 },
      scope,
    );
    expect(persist).toHaveBeenCalledTimes(2);
    await coordinator.enqueue(
      {
        ...base,
        content: "Edit from freshly loaded body",
        updated_at: "v3",
        _localUpdatedAt: 20,
      },
      scope,
    );
    expect(persist).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ updated_at: "v3" }),
      scope,
    );
  });

  it("leaves an unknown baseline for the database CAS to reject", async () => {
    const { coordinator, persist, scope } = setup();
    persist.mockResolvedValueOnce(saved("v2")).mockResolvedValueOnce(conflict);
    await coordinator.enqueue(base, scope);
    await coordinator.enqueue(
      { ...base, updated_at: "older-device-version", _localUpdatedAt: 20 },
      scope,
    );
    expect(persist).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ updated_at: "older-device-version" }),
      scope,
    );
  });

  it("cancels queued writes and completion events from an obsolete authentication lifetime", async () => {
    const { coordinator, persist, scope, session } = setup();
    const first = deferred<PersistDocumentResult>();
    const listener = vi.fn();
    coordinator.subscribe(listener);
    persist.mockReturnValue(first.promise);
    const running = coordinator.enqueue(base, scope);
    const queued = coordinator.enqueue(
      { ...base, content: "Queued", _localUpdatedAt: 11 },
      scope,
    );
    await Promise.resolve();
    session.deactivate();
    first.resolve(saved("v2"));
    expect((await running).status).toBe("cancelled");
    expect((await queued).status).toBe("cancelled");
    expect(persist).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates owners, documents, cache generations and authentication lifetimes", async () => {
    const { coordinator, persist, scope } = setup();
    persist.mockResolvedValue(conflict);
    await coordinator.enqueue(base, scope);
    await coordinator.enqueue({ ...base, id: "other-doc" }, scope);
    await coordinator.enqueue({ ...base, owner: "other-owner" }, scope);
    await coordinator.enqueue(base, {
      ...scope,
      cacheWriteToken: { owner: "owner", generation: 2 },
    });
    await coordinator.enqueue(base, {
      ...scope,
      session: createDocumentWriteSession("owner"),
    });
    expect(persist).toHaveBeenCalledTimes(5);
  });
});
