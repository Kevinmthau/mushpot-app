// @vitest-environment jsdom

import { Text } from "@codemirror/state";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDocumentDraft } from "@/components/editor/use-document-draft";
import { PrivateSessionProvider } from "@/components/pwa/private-session-provider";
import type { EditorDocument } from "@/lib/documents";
import type {
  PersistableDocumentSnapshot,
  PersistDocumentResult,
} from "@/lib/document-sync";

const mocks = vi.hoisted(() => ({
  persistDocumentSnapshot: vi.fn(),
  putCachedDocument: vi.fn(),
}));

vi.mock("@/lib/document-sync", () => ({
  normalizeDocumentTitle: (title: string) => title.trim() || "Untitled",
  persistDocumentSnapshot: mocks.persistDocumentSnapshot,
  subscribeToDocumentWrites: () => () => {},
}));
vi.mock("@/lib/doc-cache", () => ({
  getDocumentCacheWriteToken: () => ({ owner: "owner-a", generation: 1 }),
  putCachedDocument: mocks.putCachedDocument,
}));

const legacyDraft: EditorDocument = {
  id: "document-a",
  owner: "owner-a",
  title: "Offline notes",
  content: "Unsynced legacy draft",
  updated_at: "2026-09-20T10:00:00.000Z",
  share_enabled: false,
  share_token: null,
  _dirty: true,
  _baseVersionUntrusted: true,
};

let root: Root;
let draft: ReturnType<typeof useDocumentDraft>;

function Harness({ document }: { document: EditorDocument }) {
  const currentDraft = useDocumentDraft(document, true);
  useEffect(() => {
    draft = currentDraft;
  });
  return null;
}

async function render(document: EditorDocument) {
  await act(async () => root.render(createElement(
    PrivateSessionProvider,
    { initialUserId: document.owner },
    createElement(Harness, { document }),
  )));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.putCachedDocument.mockResolvedValue(true);
  mocks.persistDocumentSnapshot.mockResolvedValue({
    status: "conflict",
    cacheUpdated: false,
    persistedTitle: legacyDraft.title,
    updatedAt: "2026-09-20T11:00:00.000Z",
  } satisfies PersistDocumentResult);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("draft recovery state", () => {
  it("immediately exposes legacy recovery and retains the latest local edits after a conflict", async () => {
    await render(legacyDraft);
    expect(draft.needsDraftRecovery).toBe(true);
    expect(mocks.persistDocumentSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      draft.handleTitleChange("Revised offline notes");
      draft.handleEditorChange(Text.of(["More local work"]));
      draft.updateShareState(true, "share-token", "2026-09-20T12:00:00.000Z");
    });
    await act(async () => vi.advanceTimersByTimeAsync(800));

    expect(mocks.persistDocumentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Revised offline notes",
        content: "More local work",
        _baseVersionUntrusted: true,
      }),
      expect.objectContaining({ owner: "owner-a", generation: 1 }),
      expect.objectContaining({ owner: "owner-a", active: true }),
    );
    expect(mocks.putCachedDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "More local work", _dirty: true, _baseVersionUntrusted: true }),
      expect.objectContaining({ owner: "owner-a", generation: 1 }),
    );
    expect(draft.needsDraftRecovery).toBe(true);
    expect(draft.getLatestTitle()).toBe("Revised offline notes");
    expect(draft.getLatestContent()).toBe("More local work");
  });

  it("exposes recovery when a trusted draft encounters a remote conflict", async () => {
    await render({ ...legacyDraft, _baseVersionUntrusted: false });
    expect(draft.needsDraftRecovery).toBe(false);
    await act(async () => draft.handleEditorChange(Text.of(["Local edit"])));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(draft.needsDraftRecovery).toBe(true);
    expect(draft.getLatestContent()).toBe("Local edit");
  });

  it("clears recovery after a read confirms the draft and uses the trusted revision for later edits", async () => {
    mocks.persistDocumentSnapshot.mockImplementation(
      async (snapshot: PersistableDocumentSnapshot) => ({
        status: "saved",
        cacheUpdated: true,
        persistedTitle: snapshot.title,
        updatedAt: "2026-09-20T11:00:00.000Z",
        confirmedSnapshot: {
          ...snapshot,
          updated_at: "2026-09-20T11:00:00.000Z",
          _baseVersionUntrusted: false,
        },
      } satisfies PersistDocumentResult),
    );
    await render(legacyDraft);
    await act(async () => draft.flushLatestDraft());
    expect(draft.needsDraftRecovery).toBe(false);
    expect(mocks.persistDocumentSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ _baseVersionUntrusted: true }),
      expect.objectContaining({ owner: "owner-a", generation: 1 }),
      expect.objectContaining({ owner: "owner-a", active: true }),
    );

    await act(async () => draft.handleEditorChange(Text.of(["Next online edit"])));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(mocks.persistDocumentSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "Next online edit",
        updated_at: "2026-09-20T11:00:00.000Z",
        _baseVersionUntrusted: false,
      }),
      expect.objectContaining({ owner: "owner-a", generation: 1 }),
      expect.objectContaining({ owner: "owner-a", active: true }),
    );
    expect(draft.needsDraftRecovery).toBe(false);
  });

  it("shows recovery if legacy cache hydration arrives after the initial render", async () => {
    await render({ ...legacyDraft, _dirty: false, _baseVersionUntrusted: false });
    expect(draft.needsDraftRecovery).toBe(false);
    await render(legacyDraft);
    expect(draft.needsDraftRecovery).toBe(true);
  });
});
