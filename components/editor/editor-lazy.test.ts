import { describe, expect, it, vi } from "vitest";

import { EditorClient, preloadEditorClient } from "@/components/editor/editor-lazy";
import type { EditorDocument } from "@/components/editor/editor-types";

const { loadClient, releaseClient, clientReady } = vi.hoisted(() => {
  let releaseClient!: () => void;
  const clientReady = new Promise<void>((resolve) => {
    releaseClient = resolve;
  });
  return {
    loadClient: vi.fn(),
    releaseClient,
    clientReady,
  };
});

vi.mock("@/components/editor/editor-client", async () => {
  loadClient();
  await clientReady;
  return { EditorClient: () => null };
});

const DOCUMENT: EditorDocument = {
  id: "document-a",
  owner: "owner-a",
  title: "Draft",
  content: "Body",
  updated_at: "2026-08-17T12:00:00.000Z",
  share_enabled: false,
  share_token: null,
  _dirty: false,
};

describe("EditorClient lazy boundary", () => {
  it("keeps the core editor lazy on the document list and shares intent warmups", async () => {
    expect(loadClient).not.toHaveBeenCalled();

    const loading = preloadEditorClient();
    expect(preloadEditorClient()).toBe(loading);
    await vi.waitFor(() => expect(loadClient).toHaveBeenCalledOnce());

    releaseClient();
    await expect(loading).resolves.toHaveProperty("EditorClient");
  });

  it("forwards the local-edit signal to the loaded editor boundary", () => {
    const onLocalEdit = vi.fn();
    const element = EditorClient({
      hasResolvedRemoteState: false,
      initialDocument: DOCUMENT,
      onLocalEdit,
    });

    expect(element.props).toMatchObject({
      hasResolvedRemoteState: false,
      initialDocument: DOCUMENT,
      onLocalEdit,
    });
  });
});
