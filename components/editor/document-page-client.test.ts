// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentPageClient } from "@/components/editor/document-page-client";

const { useEditorDocument, writeSession } = vi.hoisted(() => ({
  writeSession: { owner: "owner-a", active: true, generation: 1 },
  useEditorDocument: vi.fn(() => ({
    document: null,
    error: null,
    hasResolvedRemoteState: false,
    markLocallyEdited: () => {},
    notFound: false,
  })),
}));

vi.mock("@/components/editor/editor-client", () => ({
  EditorClient: () => null,
}));
vi.mock("@/components/editor/use-editor-document", () => ({ useEditorDocument }));
vi.mock("@/components/pwa/private-session-provider", () => ({
  usePrivateSession: () => ({ userId: "owner-a", writeSession }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("document route loading", () => {
  it("passes the authenticated session lifetime while document data is unresolved", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(DocumentPageClient, { documentId: "document-a" }));
      });

      expect(useEditorDocument).toHaveBeenCalledWith("document-a", "owner-a", writeSession);
      expect(container.querySelector(".cm-theme")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
