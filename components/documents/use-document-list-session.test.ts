// @vitest-environment jsdom

import { act, createElement, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDocumentList } from "@/components/documents/use-document-list";
import {
  PrivateSessionProvider,
  usePrivateSession,
} from "@/components/pwa/private-session-provider";
import { announceDocumentCacheChange } from "@/lib/document-cache-events";
import { announceExplicitSignOutStarted } from "@/lib/auth-lifecycle-events";
import type { DocumentListItem } from "@/lib/documents";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(), read: vi.fn(), remote: vi.fn(), sync: vi.fn(), token: vi.fn(),
}));
vi.mock("@/lib/doc-cache", () => ({
  activateDocumentCacheForOwner: mocks.activate,
  getCachedDocumentListForOwner: mocks.read,
  getDocumentCacheWriteToken: mocks.token,
  syncDocumentList: mocks.sync,
}));
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: async () => ({
    from: () => {
      const query = {
        select: () => query, eq: () => query, is: () => query,
        order: () => mocks.remote(),
      };
      return query;
    },
  }),
}));

const OWNER = "owner-a";
const TOKEN = { owner: OWNER, generation: 1 };
const DOCUMENT: DocumentListItem = {
  id: "document", title: "Last list", updated_at: "2026-10-02T12:00:00Z",
};
const CLONE: DocumentListItem = {
  id: "clone", title: "New clone", updated_at: "2026-10-02T14:00:00Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}

let session: ReturnType<typeof usePrivateSession>;
let list: ReturnType<typeof useDocumentList>;
let root: Root;
let container: HTMLDivElement;
const renderedLists: string[] = [];
function SessionHarness() {
  const value = usePrivateSession();
  useEffect(() => { session = value; });
  return null;
}
function ListHarness() {
  const { userId, documentListSession } = usePrivateSession();
  const state = useDocumentList(userId, documentListSession);
  const output = state.isLoading ? "Loading documents" : state.documents.map((doc) => doc.title).join("|");
  useEffect(() => { list = state; renderedLists.push(output); });
  return createElement("p", null, output);
}
function renderList(showList: boolean, strict = false) {
  const content = createElement(
    PrivateSessionProvider,
    { initialUserId: OWNER },
    createElement(SessionHarness),
    showList ? createElement(ListHarness) : createElement("p", null, "Editor"),
  );
  root.render(strict ? createElement(StrictMode, null, content) : content);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.activate.mockResolvedValue(undefined);
  mocks.token.mockImplementation((owner: string) => ({ owner, generation: 1 }));
  mocks.read.mockResolvedValue([DOCUMENT]);
  mocks.remote.mockImplementation(() => new Promise(() => {}));
  mocks.sync.mockImplementation(async (documents: DocumentListItem[], _owner: string, token: typeof TOKEN) => {
    announceDocumentCacheChange({ type: "replace", token, documents });
    return documents;
  });
  container = document.createElement("div");
  root = createRoot(container);
  renderedLists.length = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("retained list mounted lifecycle", () => {
  it("renders the last list on the first return render while cache and network revalidate", async () => {
    await act(async () => renderList(true));
    expect(container.textContent).toBe("Last list");
    await act(async () => renderList(false));
    const cache = deferred<DocumentListItem[]>();
    mocks.read.mockReturnValue(cache.promise);
    renderedLists.length = 0;
    await act(async () => renderList(true));
    expect(renderedLists[0]).toBe("Last list");
    expect(renderedLists).not.toContain("Loading documents");
    expect(mocks.remote).toHaveBeenCalledTimes(2);
    await act(async () => cache.resolve([DOCUMENT]));
  });

  it("keeps a retained list if best-effort IndexedDB returns an empty result on return", async () => {
    await act(async () => renderList(true));
    await act(async () => renderList(false));
    mocks.read.mockResolvedValue([]);
    await act(async () => renderList(true));
    expect(container.textContent).toBe("Last list");
    expect(list.isLoading).toBe(false);
  });

  it("keeps the cold empty-cache loading state but renders confirmed empty lists immediately", async () => {
    mocks.read.mockResolvedValue([]);
    const remote = deferred<{ data: DocumentListItem[]; error: null }>();
    mocks.remote.mockReturnValue(remote.promise);
    await act(async () => renderList(true));
    expect(list.isLoading).toBe(true);
    expect(container.textContent).toBe("Loading documents");
    await act(async () => remote.resolve({ data: [], error: null }));
    expect(list.isLoading).toBe(false);
    expect(list.documents).toEqual([]);
    await act(async () => renderList(false));
    mocks.read.mockImplementation(() => new Promise(() => {}));
    mocks.remote.mockImplementation(() => new Promise(() => {}));
    renderedLists.length = 0;
    await act(async () => renderList(true));
    expect(renderedLists[0]).toBe("");
    expect(list.isLoading).toBe(false);
  });

  it("updates titles, creates/clones and deletes while the list route is unmounted", async () => {
    await act(async () => renderList(true));
    await act(async () => renderList(false));
    const updated = { ...DOCUMENT, title: "Edited title", updated_at: "2026-10-02T15:00:00Z" };
    await act(async () => {
      announceDocumentCacheChange({ type: "upsert", token: TOKEN, document: updated });
      announceDocumentCacheChange({ type: "upsert", token: TOKEN, document: CLONE });
    });
    mocks.read.mockImplementation(() => new Promise(() => {}));
    renderedLists.length = 0;
    await act(async () => renderList(true));
    expect(renderedLists[0]).toBe("Edited title|New clone");
    await act(async () => renderList(false));
    await act(async () => {
      announceDocumentCacheChange({ type: "delete", token: TOKEN, documentId: DOCUMENT.id });
    });
    renderedLists.length = 0;
    await act(async () => renderList(true));
    expect(renderedLists[0]).toBe("New clone");
  });

  it("retains server-confirmed creations when the returning route reads stale nonempty IndexedDB", async () => {
    await act(async () => renderList(true));
    await act(async () => renderList(false));
    await act(async () => session.documentListSession.confirmUpsert(OWNER, CLONE));
    // The successful server create could not update the durable cache.
    mocks.read.mockResolvedValue([DOCUMENT]);
    await act(async () => renderList(true));
    expect(list.documents).toEqual([CLONE, DOCUMENT]);
    expect(container.textContent).toBe("New clone|Last list");
  });

  it("ignores stale cache and remote responses after a committed deletion during revalidation", async () => {
    await act(async () => renderList(true));
    await act(async () => renderList(false));
    const cache = deferred<DocumentListItem[]>();
    const remote = deferred<{ data: DocumentListItem[]; error: null }>();
    mocks.read.mockReturnValue(cache.promise);
    mocks.remote.mockReturnValue(remote.promise);
    await act(async () => renderList(true));
    await act(async () => {
      announceDocumentCacheChange({ type: "delete", token: TOKEN, documentId: DOCUMENT.id });
    });
    expect(container.textContent).toBe("");
    renderedLists.length = 0;
    await act(async () => {
      cache.resolve([DOCUMENT]);
      remote.resolve({ data: [DOCUMENT], error: null });
    });
    expect(list.documents).toEqual([]);
    expect(renderedLists).not.toContain("Last list");
    expect(renderedLists).not.toContain("Loading documents");
  });

  it("keeps valid snapshots through StrictMode replay and retires them on provider unmount", async () => {
    await act(async () => renderList(true, true));
    expect(session.documentListSession.active).toBe(true);
    const previous = session.documentListSession;
    await act(async () => renderList(false, true));
    await act(async () => renderList(true, true));
    expect(container.textContent).toBe("Last list");
    expect(session.documentListSession).toBe(previous);
    await act(async () => root.render(null));
    expect(previous.active).toBe(false);
    expect(previous.getSnapshot()).toBeNull();
    announceDocumentCacheChange({ type: "replace", token: TOKEN, documents: [CLONE] });
    expect(previous.getSnapshot()).toBeNull();
  });

  it("hides retired account state synchronously and rejects late reads on replacement", async () => {
    const slow = deferred<DocumentListItem[]>();
    await act(async () => renderList(true));
    const original = session.documentListSession;
    await act(async () => renderList(false));
    mocks.read.mockImplementation((owner: string) => owner === OWNER
      ? slow.promise : new Promise(() => {}));
    await act(async () => renderList(true));
    await act(async () => session.setUserId("owner-b"));
    expect(original.getSnapshot()).toBeNull();
    expect(list.documents).toEqual([]);
    await act(async () => {
      slow.resolve([DOCUMENT]);
      announceDocumentCacheChange({ type: "replace", token: TOKEN, documents: [DOCUMENT] });
    });
    expect(list.documents).toEqual([]);
    expect(session.documentListSession.owner).toBe("owner-b");
  });

  it("invalidates explicit sign-out immediately and creates a fresh same-owner session after recovery", async () => {
    await act(async () => renderList(true));
    const previous = session.documentListSession;
    await act(async () => announceExplicitSignOutStarted(OWNER));
    expect(previous.active).toBe(false);
    expect(previous.getSnapshot()).toBeNull();
    expect(list.documents).toEqual([]);
    mocks.read.mockImplementation(() => new Promise(() => {}));
    renderedLists.length = 0;
    await act(async () => session.setUserId(OWNER));
    expect(renderedLists).not.toContain("Last list");
    expect(session.documentListSession).not.toBe(previous);
    expect(session.documentListSession.getSnapshot()).toBeNull();
    expect(list.documents).toEqual([]);
  });
});
