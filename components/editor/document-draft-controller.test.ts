import { Text } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentDraftController } from "@/components/editor/document-draft-controller";
import type { EditorDocument } from "@/lib/documents";
import type {
  PersistableDocumentSnapshot,
  PersistDocumentResult,
} from "@/lib/document-sync";
import type { DocumentWriteEvent } from "@/lib/document-write-coordinator";

const document: EditorDocument = {
  id: "doc",
  owner: "owner",
  title: "Title",
  content: "Body",
  updated_at: "2026-09-20T10:00:00Z",
  share_enabled: false,
  share_token: null,
};
const saved: PersistDocumentResult = {
  status: "saved",
  cacheUpdated: true,
  ok: true,
  conflict: false,
  updatedAt: "2026-09-20T11:00:00Z",
  persistedTitle: "Title",
};
const conflict: PersistDocumentResult = {
  ...saved,
  status: "conflict",
  ok: false,
  conflict: true,
  cacheUpdated: false,
};

function setup(initial = document, resolved = true) {
  const cache = vi.fn(async () => true);
  const persist = vi
    .fn<
      (snapshot: PersistableDocumentSnapshot) => Promise<PersistDocumentResult>
    >()
    .mockResolvedValue(saved);
  let onWrite!: (event: DocumentWriteEvent) => void;
  const unsubscribe = vi.fn();
  const controller = new DocumentDraftController(initial, resolved, {
    cache,
    persist,
    subscribe: (listener) => {
      onWrite = listener;
      return unsubscribe;
    },
  });
  const listener = vi.fn();
  const lifecycle = controller.start(listener);
  return {
    controller,
    cache,
    persist,
    lifecycle,
    listener,
    unsubscribe,
    emit: (event: DocumentWriteEvent) => onWrite(event),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("draft controller", () => {
  it.each([
    { title: "", persistedTitle: "Untitled" },
    { title: "  \t ", persistedTitle: "Untitled" },
    { title: "  Weekend notes  ", persistedTitle: "Weekend notes" },
  ])(
    "cleans a background save of cached title '$title' against its confirmed title",
    async ({ title, persistedTitle }) => {
      const initial = { ...document, title, _dirty: true };
      const { controller, cache, persist, emit, lifecycle } = setup(initial);

      emit({ snapshot: initial, result: { ...saved, persistedTitle } });

      expect(controller.getView().saveStatus).toBe("saved");
      expect(cache).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: persistedTitle, _dirty: false }),
      );
      await vi.advanceTimersByTimeAsync(800);
      await controller.save();
      expect(persist).not.toHaveBeenCalled();
      lifecycle.stop();
    },
  );

  it("retains legacy version uncertainty through edits and sharing until a confirmed save", async () => {
    const { controller, persist, cache } = setup({
      ...document,
      _dirty: true,
      _baseVersionUntrusted: true,
    });
    controller.handleEditorChange(Text.of(["Edited legacy draft"]));
    controller.updateShareState(true, "token", "2026-09-20T10:30:00Z", {
      title: "Title",
      content: "Body",
    });
    await controller.save();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Edited legacy draft",
        updated_at: document.updated_at,
        _baseVersionUntrusted: true,
      }),
    );
    expect(cache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        _baseVersionUntrusted: false,
        updated_at: saved.updatedAt,
      }),
    );
  });

  it("preserves a divergent legacy draft on trusted hydration and clears uncertainty only for a matching body", async () => {
    const conflicted = setup({
      ...document,
      _dirty: true,
      _baseVersionUntrusted: true,
    });
    conflicted.controller.hydrate(
      { ...document, content: "Remote body" },
      true,
    );
    expect(conflicted.controller.getLatestContent()).toBe("Body");
    expect(conflicted.controller.getView().saveStatus).toBe("conflict");
    expect(conflicted.cache).toHaveBeenLastCalledWith(
      expect.objectContaining({ _baseVersionUntrusted: true, _dirty: true }),
    );
    conflicted.lifecycle.stop();

    const matching = setup({
      ...document,
      _dirty: true,
      _baseVersionUntrusted: true,
    });
    matching.controller.hydrate(
      { ...document, updated_at: "2026-09-20T10:30:00Z" },
      true,
    );
    matching.controller.handleEditorChange(Text.of(["Next edit"]));
    await matching.controller.save();
    expect(matching.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        _baseVersionUntrusted: false,
        updated_at: "2026-09-20T10:30:00Z",
      }),
    );
  });

  it("keeps CodeMirror Text lazy and serializes once for stats, cache and autosave", async () => {
    const { controller, persist, cache } = setup();
    const text = Text.of(["Typing"]);
    const serialize = vi.spyOn(text, "toString");
    controller.handleEditorChange(text);
    expect(serialize).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(serialize).toHaveBeenCalledOnce();
    expect(cache).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Typing" }),
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Typing",
        updated_at: document.updated_at,
      }),
    );
  });

  it("merges an untouched remote body before saving a local title edit", async () => {
    const { controller, persist } = setup(document, false);
    controller.handleTitleChange("Local title");
    await vi.advanceTimersByTimeAsync(800);
    expect(persist).not.toHaveBeenCalled();
    controller.hydrate(
      {
        ...document,
        content: "Remote body",
        updated_at: "2026-09-20T10:30:00Z",
      },
      true,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Local title",
        content: "Remote body",
        updated_at: "2026-09-20T10:30:00Z",
      }),
    );
  });

  it("preserves local text and its original version when hydration overlaps local edits", async () => {
    const { controller, persist, cache } = setup(document, false);
    controller.handleEditorChange(Text.of(["Local body"]));
    controller.hydrate(
      {
        ...document,
        content: "Remote body",
        updated_at: "2026-09-20T10:30:00Z",
      },
      true,
    );
    await vi.advanceTimersByTimeAsync(800);
    expect(controller.getLatestContent()).toBe("Local body");
    expect(controller.getView().saveStatus).toBe("conflict");
    expect(persist).not.toHaveBeenCalled();
    expect(cache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "Local body",
        updated_at: document.updated_at,
        _dirty: true,
      }),
    );
  });

  it("retains conflict text through further edits, sharing, visibility and hydration", async () => {
    const { controller, persist, cache, lifecycle } = setup({
      ...document,
      _dirty: true,
    });
    persist.mockResolvedValue(conflict);
    await controller.save();
    controller.handleEditorChange(Text.of(["More local text"]));
    controller.updateShareState(true, "token", "2026-09-20T12:00:00Z", {
      content: "Remote text",
      title: "Title",
    });
    controller.hydrate(
      {
        ...document,
        content: "Remote text",
        updated_at: "2026-09-20T12:00:00Z",
      },
      true,
    );
    lifecycle.handlePageHide();
    lifecycle.handleVisibilityChange("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(persist).toHaveBeenCalledOnce();
    expect(controller.getLatestContent()).toBe("More local text");
    expect(controller.getView().saveStatus).toBe("conflict");
    expect(cache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "More local text",
        updated_at: document.updated_at,
        _dirty: true,
      }),
    );
  });

  it("reconciles background saves without replacing newer local text", async () => {
    const { controller, emit, cache } = setup({
      ...document,
      _dirty: true,
      _localUpdatedAt: 10,
    });
    controller.handleEditorChange(Text.of(["Newer local text"]));
    emit({ snapshot: { ...document, _localUpdatedAt: 10 }, result: saved });
    expect(controller.getLatestContent()).toBe("Newer local text");
    expect(cache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "Newer local text",
        updated_at: saved.updatedAt,
        _dirty: true,
      }),
    );
  });

  it("survives setup-cleanup-setup and writes the latest draft on unmount before debounce", async () => {
    const { controller, lifecycle, cache, persist, unsubscribe } = setup();
    lifecycle.stop();
    const remounted = controller.start(() => {});
    controller.handleEditorChange(Text.of(["Unsaved on exit"]));
    remounted.stop();
    expect(cache).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "Unsaved on exit", _dirty: true }),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not schedule retries from an in-flight save after unmount", async () => {
    const { controller, lifecycle, persist } = setup();
    let resolve!: (result: PersistDocumentResult) => void;
    persist.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    controller.handleEditorChange(Text.of(["Draft"]));
    const saving = controller.save();
    lifecycle.stop();
    resolve({ ...saved, status: "retryable", ok: false });
    await saving;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("retries transient failures without changing the original CAS timestamp", async () => {
    const { controller, persist } = setup({ ...document, _dirty: true });
    persist
      .mockResolvedValueOnce({ ...saved, status: "retryable", ok: false })
      .mockResolvedValueOnce(saved);
    await controller.save();
    expect(controller.getView().saveStatus).toBe("retryable");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(persist).toHaveBeenLastCalledWith(
      expect.objectContaining({ updated_at: document.updated_at }),
    );
    expect(controller.getView().saveStatus).toBe("saved");
  });

  it("adopts a sharing timestamp only with a matching confirmed body", async () => {
    const { controller, persist } = setup();
    controller.updateShareState(true, "token", "2026-09-20T10:30:00Z", {
      title: "Title",
      content: "Body",
    });
    controller.handleEditorChange(Text.of(["Draft"]));
    await controller.save();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ updated_at: "2026-09-20T10:30:00Z" }),
    );
  });
});
