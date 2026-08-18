import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  acceptExternalEditorValue,
  activateEditorValueHandoff,
  createEditorValueHandoffState,
  recordLocalEditorValue,
} from "@/components/editor/code-mirror-editor";

describe("CodeMirror external value handoff", () => {
  it("retains CodeMirror Text without serializing each local edit", () => {
    const document = Text.of(["User edit before remote"]);
    const edited = recordLocalEditorValue(
      createEditorValueHandoffState("document-a", "Cached content"),
      "document-a",
      document,
    );

    expect(edited.value).toBe(document);
    expect(edited.hasLocalEdits).toBe(true);
  });

  it("does not replace a local edit when remote reconciliation finishes", () => {
    const cached = createEditorValueHandoffState(
      "document-a",
      "Cached content",
    );
    const edited = recordLocalEditorValue(
      cached,
      "document-a",
      "User edit before remote",
    );
    const remote = acceptExternalEditorValue(
      edited,
      "document-a",
      "Newer remote content",
    );

    expect(remote.valueToApply).toBeNull();
    expect(remote.state).toEqual({
      documentId: "document-a",
      hasLocalEdits: true,
      value: "User edit before remote",
    });
  });

  it("applies a remote value while the cached editor is still untouched", () => {
    const cached = createEditorValueHandoffState(
      "document-a",
      "Cached content",
    );
    const remote = acceptExternalEditorValue(
      cached,
      "document-a",
      "Newer remote content",
    );

    expect(remote.valueToApply).toBe("Newer remote content");
    expect(remote.state.value).toBe("Newer remote content");
    expect(remote.state.hasLocalEdits).toBe(false);
  });

  it("resets local-edit protection when a different document opens", () => {
    const edited = recordLocalEditorValue(
      createEditorValueHandoffState("document-a", "First"),
      "document-a",
      "Edited first",
    );
    const nextDocument = activateEditorValueHandoff(
      edited,
      "document-b",
      "Second",
    );

    expect(nextDocument).toEqual({
      documentId: "document-b",
      hasLocalEdits: false,
      value: "Second",
    });
  });
});
