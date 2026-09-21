import { Text } from "@codemirror/state";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PersistableDocumentSnapshot, PersistDocumentResult } from "@/lib/document-sync";

const initial = {
  id: "doc",
  owner: "owner",
  title: "Title",
  content: "Original body",
  updated_at: "2026-09-20T10:00:00Z",
  share_enabled: false,
  share_token: null,
  _localUpdatedAt: 10,
  _dirty: false,
};

const retryable: PersistDocumentResult = {
  status: "retryable",
  cacheUpdated: false,
  conflict: false,
  ok: false,
  persistedTitle: initial.title,
  updatedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => vi.unstubAllGlobals());

async function setup(resolved = true) {
  const cache = await import("@/lib/doc-cache");
  const { DocumentDraftController } =
    await import("@/components/editor/document-draft-controller");
  await cache.activateDocumentCacheForOwner(initial.owner);
  await cache.putCachedDocument(initial);
  const writes: Promise<boolean>[] = [];
  const persist = vi
    .fn<(snapshot: PersistableDocumentSnapshot) => Promise<PersistDocumentResult>>()
    .mockResolvedValue(retryable);
  const controller = new DocumentDraftController(initial, resolved, {
    cache(snapshot) {
      const write = cache.putCachedDocument(snapshot);
      writes.push(write);
      return write;
    },
    persist,
  });
  return {
    controller,
    lifecycle: controller.start(() => {}),
    persist,
    async readDurableDraft() {
      await Promise.all(writes);
      return cache.getCachedDocumentForOwner(initial.id, initial.owner);
    },
  };
}

describe("durable reverted draft intent", () => {
  it("replaces an intermediate dirty cache row with the latest revert on unmount", async () => {
    const { controller, lifecycle, persist, readDurableDraft } = await setup();
    controller.handleEditorChange(Text.of(["Intermediate edit"]));
    await controller.flushLatestDraft();
    controller.handleEditorChange(Text.of([initial.content]));
    lifecycle.stop();

    expect(persist).toHaveBeenCalledOnce();
    expect(await readDurableDraft()).toMatchObject({
      content: initial.content,
      _dirty: true,
    });
  });

  it("preserves a revert across initial remote hydration and immediate unmount", async () => {
    const { controller, lifecycle, persist, readDurableDraft } = await setup(false);
    controller.handleEditorChange(Text.of(["Intermediate edit"]));
    await controller.flushLatestDraft();
    controller.handleEditorChange(Text.of([initial.content]));
    controller.hydrate(initial, true);
    lifecycle.stop();

    expect(persist).not.toHaveBeenCalled();
    expect(await readDurableDraft()).toMatchObject({
      content: initial.content,
      _dirty: true,
    });
  });

  it("marks a revert dirty before an older in-flight request can commit after exit", async () => {
    const { controller, lifecycle, persist, readDurableDraft } = await setup();
    let finishSave!: (result: PersistDocumentResult) => void;
    persist.mockReturnValueOnce(new Promise((resolve) => {
      finishSave = resolve;
    }));
    controller.handleEditorChange(Text.of(["Intermediate edit"]));
    const saving = controller.save();
    controller.handleEditorChange(Text.of([initial.content]));
    lifecycle.stop();

    expect(await readDurableDraft()).toMatchObject({
      content: initial.content,
      _dirty: true,
    });

    finishSave({
      ...retryable,
      status: "saved",
      ok: true,
      updatedAt: "2026-09-20T11:00:00Z",
    });
    await saving;
    expect(await readDurableDraft()).toMatchObject({
      content: initial.content,
      updated_at: "2026-09-20T11:00:00Z",
      _dirty: true,
    });
  });
});
