// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HomeLoading from "@/app/(private)/loading";
import {
  PrivateSessionProvider,
  usePrivateSession,
} from "@/components/pwa/private-session-provider";
import { announceDocumentCacheChange } from "@/lib/document-cache-events";
import { announceExplicitSignOutStarted } from "@/lib/auth-lifecycle-events";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(), read: vi.fn(), sync: vi.fn(), put: vi.fn(),
  client: vi.fn(), preload: vi.fn(), warm: vi.fn(), push: vi.fn(), prefetch: vi.fn(),
}));
vi.mock("@/lib/doc-cache", () => ({
  activateDocumentCacheForOwner: mocks.activate,
  getCachedDocumentListForOwner: mocks.read,
  syncDocumentList: mocks.sync,
  putCachedDocument: mocks.put,
  getDocumentCacheWriteToken: (owner: string) => ({ owner, generation: 1 }),
}));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseBrowserClient: mocks.client }));
vi.mock("@/components/editor/editor-lazy", () => ({ preloadEditorClient: mocks.preload }));
vi.mock("@/components/editor/editor-document-request", () => ({ warmEditorDocument: mocks.warm }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, prefetch: mocks.prefetch }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

const OWNER = "owner-a";
const DOCUMENT = {
  id: "document", title: "Last list", updated_at: "2026-10-02T12:00:00Z",
};
let session: ReturnType<typeof usePrivateSession>;
let root: Root;
let container: HTMLDivElement;

function SessionHarness() {
  const value = usePrivateSession();
  useEffect(() => { session = value; });
  return null;
}
function renderLoading(showLoading = true) {
  root.render(createElement(
    PrivateSessionProvider,
    { initialUserId: OWNER },
    createElement(SessionHarness),
    showLoading ? createElement(HomeLoading) : createElement("p", null, "Editor"),
  ));
}
function expectNoLoadingWork() {
  for (const operation of [mocks.activate, mocks.read, mocks.sync, mocks.put, mocks.client,
    mocks.preload, mocks.warm, mocks.push, mocks.prefetch]) {
    expect(operation).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("retained document-list route fallback", () => {
  it("renders retained links immediately while the returning route is pending without starting loads", async () => {
    await act(async () => renderLoading(false));
    session.documentListSession.publishRemoteFallback([DOCUMENT]);
    act(() => renderLoading());
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/doc/document");
    expect(container.textContent).toContain("Last list");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expectNoLoadingWork();
  });

  it("keeps the normal route skeleton when the session has no known list", async () => {
    await act(async () => renderLoading());
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label"))
      .toBe("Loading documents");
    expect(container.querySelector("a")).toBeNull();
    expectNoLoadingWork();
  });

  it("renders a confirmed empty snapshot as an empty list instead of a spinner", async () => {
    await act(async () => renderLoading(false));
    session.documentListSession.publishRemoteFallback([]);
    act(() => renderLoading());
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('button[aria-label="New document"]')).not.toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expectNoLoadingWork();
  });

  it("updates retained titles and deletions during a pending route", async () => {
    await act(async () => renderLoading(false));
    session.documentListSession.publishRemoteFallback([DOCUMENT]);
    await act(async () => renderLoading());
    await act(async () => announceDocumentCacheChange({
      type: "upsert", token: { owner: OWNER, generation: 1 },
      document: { ...DOCUMENT, title: "Edited in the editor" },
    }));
    expect(container.textContent).toContain("Edited in the editor");
    await act(async () => session.documentListSession.confirmDeletion(OWNER, DOCUMENT.id));
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expectNoLoadingWork();
  });

  it("clears rows when explicit sign-out retires the session and rejects late old events", async () => {
    await act(async () => renderLoading(false));
    session.documentListSession.publishRemoteFallback([DOCUMENT]);
    await act(async () => renderLoading());
    await act(async () => announceExplicitSignOutStarted(OWNER));
    expect(container.textContent).not.toContain("Last list");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => announceDocumentCacheChange({
      type: "replace", token: { owner: OWNER, generation: 1 }, documents: [DOCUMENT],
    }));
    expect(container.querySelector("a")).toBeNull();
    expectNoLoadingWork();
  });

  it("clears retained rows on account change before showing the replacement list", async () => {
    await act(async () => renderLoading(false));
    session.documentListSession.publishRemoteFallback([DOCUMENT]);
    await act(async () => renderLoading());
    const previous = session.documentListSession;
    await act(async () => session.setUserId("owner-b"));
    expect(container.textContent).not.toContain("Last list");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(previous.active).toBe(false);
    await act(async () => session.documentListSession.publishRemoteFallback([
      { ...DOCUMENT, id: "replacement", title: "Replacement account" },
    ]));
    expect(container.textContent).toContain("Replacement account");
    expect(container.textContent).not.toContain("Last list");
    expectNoLoadingWork();
  });
});
