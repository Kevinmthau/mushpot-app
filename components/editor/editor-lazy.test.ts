import { describe, expect, it, vi } from "vitest";

import { EditorClient } from "@/components/editor/editor-lazy";
import type { EditorDocument } from "@/components/editor/editor-types";

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
