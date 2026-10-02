// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEditorDocument } from "@/components/editor/use-editor-document";
import { createDocumentWriteSession, type DocumentWriteSession } from "@/lib/document-write-coordinator";
import type { EditorDocument } from "@/lib/documents";
import type { EditorRemoteResult } from "@/components/editor/editor-document-request";

const { cache, remote } = vi.hoisted(() => ({ cache: vi.fn(), remote: vi.fn() }));
vi.mock("@/lib/doc-cache", () => ({
  activateDocumentCacheForOwner: async () => {},
  getDocumentCacheWriteToken: () => ({ owner: "owner", generation: 1 }),
  getCachedDocumentForOwner: cache,
  reconcileCachedDocumentWithServer: async (document: EditorDocument) => document,
}));
vi.mock("@/components/editor/editor-document-request", () => ({
  loadRemoteEditorDocument: remote,
}));

const DOCUMENT: EditorDocument = {
  id: "doc-a", owner: "owner", title: "Title", content: "Body",
  updated_at: "2026-10-01T12:00:00Z", share_enabled: false, share_token: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
function Harness({ id, session }: { id: string; session: DocumentWriteSession }) {
  const state = useEditorDocument(id, "owner", session);
  return createElement("p", null, state.document?.content ?? "Loading");
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("mounted editor document lifetime", () => {
  it("hides the prior document while switching routes and ignores its delayed response", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const session = createDocumentWriteSession("owner");
    const first = deferred<EditorRemoteResult>();
    const second = deferred<EditorRemoteResult>();
    cache.mockResolvedValueOnce(DOCUMENT).mockResolvedValueOnce(null);
    remote.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    try {
      await act(async () => root.render(createElement(Harness, { id: "doc-a", session })));
      expect(container.textContent).toBe("Body");
      await act(async () => root.render(createElement(Harness, { id: "doc-b", session })));
      expect(container.textContent).toBe("Loading");
      await act(async () => first.resolve({ document: DOCUMENT, error: null }));
      expect(container.textContent).toBe("Loading");
      await act(async () => second.resolve({
        document: { ...DOCUMENT, id: "doc-b", content: "Second document" }, error: null,
      }));
      expect(container.textContent).toBe("Second document");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not expose prior state to a replacement session for the same owner", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const session = createDocumentWriteSession("owner");
    const old = deferred<EditorRemoteResult>();
    const current = deferred<EditorRemoteResult>();
    cache.mockResolvedValueOnce(DOCUMENT).mockResolvedValueOnce(null);
    remote.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    try {
      await act(async () => root.render(createElement(Harness, { id: "doc-a", session })));
      expect(container.textContent).toBe("Body");
      session.deactivate();
      const replacement = createDocumentWriteSession("owner");
      await act(async () => root.render(createElement(Harness, { id: "doc-a", session: replacement })));
      expect(container.textContent).toBe("Loading");
      await act(async () => old.resolve({ document: DOCUMENT, error: null }));
      expect(container.textContent).toBe("Loading");
      await act(async () => current.resolve({
        document: { ...DOCUMENT, content: "New session" }, error: null,
      }));
      expect(container.textContent).toBe("New session");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
