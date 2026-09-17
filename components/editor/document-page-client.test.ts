// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentPageClient } from "@/components/editor/document-page-client";

const { preloadEditorClient, useEditorDocument } = vi.hoisted(() => ({
  preloadEditorClient: vi.fn(() => Promise.resolve()),
  useEditorDocument: vi.fn(() => ({
    document: null,
    error: null,
    hasResolvedRemoteState: false,
    markLocallyEdited: () => {},
    notFound: false,
  })),
}));

vi.mock("@/components/editor/editor-lazy", () => ({
  EditorClient: () => null,
  preloadEditorClient,
}));
vi.mock("@/components/editor/use-editor-document", () => ({ useEditorDocument }));
vi.mock("@/components/pwa/private-session-provider", () => ({
  usePrivateSession: () => ({ userId: "owner-a" }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("document route editor warmup", () => {
  it("starts loading editor code while document data is still unresolved", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(DocumentPageClient, { documentId: "document-a" }));
      });

      expect(useEditorDocument).toHaveBeenCalledWith("document-a", "owner-a");
      expect(preloadEditorClient).toHaveBeenCalledOnce();
      expect(container.querySelector(".cm-theme")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
