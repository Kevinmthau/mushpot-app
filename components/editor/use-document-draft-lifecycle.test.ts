// @vitest-environment jsdom

import { Text } from "@codemirror/state";
import { act, createElement, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDocumentDraft } from "@/components/editor/use-document-draft";
import {
  PrivateSessionProvider,
  usePrivateSession,
} from "@/components/pwa/private-session-provider";
import type {
  PersistableDocumentSnapshot,
  PersistDocumentResult,
  SavedDocumentResult,
} from "@/lib/document-sync";
import type { EditorDocument } from "@/lib/documents";

const mocks = vi.hoisted(() => ({
  cache: vi.fn(),
  persist: vi.fn(),
  subscribe: vi.fn(),
  getToken: vi.fn(),
}));
vi.mock("@/lib/doc-cache", () => ({
  getDocumentCacheWriteToken: mocks.getToken,
  putCachedDocument: mocks.cache,
}));
vi.mock("@/lib/document-sync", () => ({
  persistDocumentSnapshot: mocks.persist,
  normalizeDocumentTitle: (title: string) => title.trim() || "Untitled",
  subscribeToDocumentWrites: mocks.subscribe,
}));

const initialDocument: EditorDocument = {
  id: "doc",
  owner: "owner",
  title: "Title",
  content: "Body",
  updated_at: "2026-09-20T10:00:00Z",
  share_enabled: false,
  share_token: null,
};
function savedResult(
  snapshot: PersistableDocumentSnapshot,
  updatedAt = "2026-09-20T11:00:00Z",
): SavedDocumentResult {
  const persistedTitle = snapshot.title.trim() || "Untitled";
  return {
    status: "saved",
    cacheUpdated: true,
    persistedTitle,
    updatedAt,
    confirmedSnapshot: {
      ...snapshot,
      title: persistedTitle,
      updated_at: updatedAt,
      _baseVersionUntrusted: false,
    },
  };
}
let api: ReturnType<typeof useDocumentDraft>;
let session: ReturnType<typeof usePrivateSession>;
function Harness() {
  const draft = useDocumentDraft(initialDocument, true);
  const privateSession = usePrivateSession();
  useEffect(() => {
    api = draft;
    session = privateSession;
  });
  return createElement("p", { "data-status": draft.saveStatus }, draft.title);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.cache.mockResolvedValue(true);
  mocks.getToken.mockReturnValue({ owner: "owner", generation: 1 });
  mocks.persist.mockImplementation(
    async (snapshot: PersistableDocumentSnapshot) => savedResult(snapshot),
  );
  mocks.subscribe.mockReturnValue(() => {});
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mounted draft lifecycle", () => {
  it("autosaves after StrictMode replay and caches a final edit on immediate unmount", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            PrivateSessionProvider,
            { initialUserId: "owner" },
            createElement(Harness),
          ),
        ),
      ),
    );
    await act(async () => {
      api.handleEditorChange(Text.of(["First edit"]));
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ content: "First edit" }),
      expect.anything(),
      expect.objectContaining({ owner: "owner", active: true }),
    );
    await act(async () => {
      api.handleEditorChange(Text.of(["Final edit"]));
    });
    await act(async () => root.unmount());
    expect(mocks.cache).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "Final edit", _dirty: true }),
      expect.anything(),
    );
    expect(session.writeSession.active).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it("adopts a recovered cache once without crossing a later revoked generation", async () => {
    mocks.getToken.mockReturnValue(null);
    const root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(
        createElement(
          PrivateSessionProvider,
          { initialUserId: "owner" },
          createElement(Harness),
        ),
      ),
    );
    await act(async () => {
      api.handleEditorChange(Text.of(["First draft"]));
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mocks.persist).toHaveBeenLastCalledWith(
      expect.anything(),
      null,
      expect.anything(),
    );
    mocks.getToken.mockReturnValue({ owner: "owner", generation: 1 });
    await act(async () => {
      api.handleEditorChange(Text.of(["After cache recovery"]));
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mocks.persist).toHaveBeenLastCalledWith(
      expect.anything(),
      { owner: "owner", generation: 1 },
      expect.anything(),
    );
    mocks.getToken.mockReturnValue({ owner: "owner", generation: 2 });
    await act(async () => {
      api.handleEditorChange(Text.of(["After revocation"]));
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mocks.persist).toHaveBeenLastCalledWith(
      expect.anything(),
      { owner: "owner", generation: 1 },
      expect.anything(),
    );
    await act(async () => root.unmount());
  });

  it("queues the last local write when the editor leaves a still-active session", async () => {
    const root = createRoot(document.createElement("div"));
    const render = (child: boolean) =>
      createElement(
        PrivateSessionProvider,
        { initialUserId: "owner" },
        child ? createElement(Harness) : null,
      );
    await act(async () => root.render(render(true)));
    await act(async () => {
      api.handleEditorChange(Text.of(["Exit before debounce"]));
    });
    await act(async () => root.render(render(false)));
    expect(mocks.cache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "Exit before debounce",
        _dirty: true,
      }),
      expect.anything(),
    );
    await act(async () => root.unmount());
  });

  it("rebinds a renewed session without losing edits or accepting an old save completion", async () => {
    const root = createRoot(document.createElement("div"));
    let finishOldSave!: (result: PersistDocumentResult) => void;
    mocks.persist.mockReturnValueOnce(
      new Promise<PersistDocumentResult>((resolve) => {
        finishOldSave = resolve;
      }),
    );
    await act(async () =>
      root.render(
        createElement(
          PrivateSessionProvider,
          { initialUserId: "owner" },
          createElement(Harness),
        ),
      ),
    );
    await act(async () => {
      api.handleEditorChange(Text.of(["Text from the first session"]));
      await vi.advanceTimersByTimeAsync(800);
    });
    const retiredSession = session.writeSession;
    await act(async () => {
      api.handleEditorChange(Text.of(["Keep edits made before renewal"]));
      session.clearUserId();
      session.setUserId("owner");
    });
    const renewedSession = session.writeSession;
    expect(renewedSession).not.toBe(retiredSession);
    expect(retiredSession.active).toBe(false);
    expect(api.getLatestContent()).toBe("Keep edits made before renewal");
    expect(mocks.cache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "Keep edits made before renewal",
        _dirty: true,
      }),
      expect.anything(),
    );
    await act(async () => {
      api.handleEditorChange(
        Text.of(["Continue writing in the renewed session"]),
      );
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mocks.persist).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "Continue writing in the renewed session",
      }),
      expect.anything(),
      renewedSession,
    );
    expect(api.saveStatus).toBe("saved");
    await act(async () =>
      finishOldSave(savedResult(
        mocks.persist.mock.calls[0][0],
        "2026-09-20T12:00:00Z",
      )),
    );
    expect(api.getLatestContent()).toBe(
      "Continue writing in the renewed session",
    );
    expect(api.saveStatus).toBe("saved");
    expect(mocks.cache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "Continue writing in the renewed session",
        _dirty: false,
        updated_at: "2026-09-20T11:00:00Z",
      }),
      expect.anything(),
    );
    await act(async () => root.unmount());
  });

  it.each([null, { owner: "owner", generation: 1 }])(
    "keeps local text outside a different owner's session with cache token %j",
    async (cacheToken) => {
      mocks.getToken.mockReturnValue(cacheToken);
      const root = createRoot(document.createElement("div"));
      await act(async () =>
        root.render(
          createElement(
            PrivateSessionProvider,
            { initialUserId: "owner" },
            createElement(Harness),
          ),
        ),
      );
      await act(async () => {
        api.handleEditorChange(Text.of(["Original owner's pending text"]));
        session.setUserId("different-owner");
      });
      expect(api.getLatestContent()).toBe("Original owner's pending text");
      expect(session.writeSession.owner).toBe("different-owner");
      await act(async () => {
        api.handleEditorChange(
          Text.of(["Retain text until the route unmounts"]),
        );
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(api.getLatestContent()).toBe(
        "Retain text until the route unmounts",
      );
      expect(mocks.cache).not.toHaveBeenCalled();
      expect(mocks.persist).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      expect(mocks.cache).not.toHaveBeenCalled();
    },
  );

  it("renders a conflict without losing text and retires the session synchronously on sign-out", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    mocks.persist.mockResolvedValue({
      status: "conflict",
      cacheUpdated: false,
      persistedTitle: "Title",
      updatedAt: "2026-09-20T11:00:00Z",
    } satisfies PersistDocumentResult);
    await act(async () =>
      root.render(
        createElement(
          PrivateSessionProvider,
          { initialUserId: "owner" },
          createElement(Harness),
        ),
      ),
    );
    await act(async () => {
      api.handleEditorChange(Text.of(["Conflict draft"]));
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(container.querySelector("p")?.getAttribute("data-status")).toBe(
      "conflict",
    );
    expect(api.getLatestContent()).toBe("Conflict draft");
    const originalSession = session.writeSession;
    await act(async () => {
      session.clearUserId();
      expect(originalSession.active).toBe(false);
      session.setUserId("owner");
    });
    expect(session.writeSession).not.toBe(originalSession);
    await act(async () => root.unmount());
  });
});
