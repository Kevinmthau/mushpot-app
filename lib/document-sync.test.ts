import { describe, expect, it } from "vitest";

import { normalizeDocumentTitle } from "@/lib/document-sync";

describe("normalizeDocumentTitle", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeDocumentTitle("  My Notes  ")).toBe("My Notes");
  });

  it("falls back to 'Untitled' for empty or whitespace-only titles", () => {
    expect(normalizeDocumentTitle("")).toBe("Untitled");
    expect(normalizeDocumentTitle("   \t ")).toBe("Untitled");
  });

  it("leaves an already-clean title unchanged", () => {
    expect(normalizeDocumentTitle("Roadmap")).toBe("Roadmap");
  });
});
