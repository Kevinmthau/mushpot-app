import { describe, expect, it } from "vitest";

import {
  areEditorDocumentsEqual,
  getDocumentDisplayTitle,
  toCachedDocument,
  toEditorDocument,
  type EditorDocument,
} from "@/lib/documents";

function makeEditorDocument(
  overrides: Partial<EditorDocument> = {},
): EditorDocument {
  return {
    id: "doc-1",
    owner: "user-1",
    title: "Roadmap",
    content: "# Plans",
    updated_at: "2026-05-17T12:00:00.000Z",
    share_enabled: false,
    share_token: null,
    ...overrides,
  };
}

describe("getDocumentDisplayTitle", () => {
  it("returns the title when it is non-empty", () => {
    expect(getDocumentDisplayTitle("Roadmap")).toBe("Roadmap");
  });

  it("falls back to 'Untitled' for an empty title", () => {
    expect(getDocumentDisplayTitle("")).toBe("Untitled");
  });
});

describe("toCachedDocument", () => {
  it("copies all editor fields and marks the document clean", () => {
    const cached = toCachedDocument(makeEditorDocument());
    expect(cached._dirty).toBe(false);
    expect(cached.id).toBe("doc-1");
    expect(cached.content).toBe("# Plans");
  });
});

describe("toEditorDocument", () => {
  it("projects exactly the editor document fields", () => {
    const editorDocument = toEditorDocument(makeEditorDocument());
    expect(Object.keys(editorDocument).sort()).toEqual(
      [
        "content",
        "id",
        "owner",
        "share_enabled",
        "share_token",
        "title",
        "updated_at",
      ].sort(),
    );
  });
});

describe("areEditorDocumentsEqual", () => {
  it("returns true for documents with identical fields", () => {
    expect(
      areEditorDocumentsEqual(makeEditorDocument(), makeEditorDocument()),
    ).toBe(true);
  });

  it("returns false when any single field differs", () => {
    const base = makeEditorDocument();
    const fields: Partial<EditorDocument>[] = [
      { id: "other" },
      { owner: "other" },
      { title: "Other" },
      { content: "other" },
      { updated_at: "2026-01-01T00:00:00.000Z" },
      { share_enabled: true },
      { share_token: "token" },
    ];

    for (const override of fields) {
      expect(
        areEditorDocumentsEqual(base, makeEditorDocument(override)),
      ).toBe(false);
    }
  });
});
