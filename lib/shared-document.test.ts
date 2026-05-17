import { describe, expect, it } from "vitest";

import {
  buildSharedDocumentPreview,
  normalizeSharedDocumentTitle,
} from "@/lib/shared-document";

describe("normalizeSharedDocumentTitle", () => {
  it("trims the title", () => {
    expect(normalizeSharedDocumentTitle("  My Doc  ")).toBe("My Doc");
  });

  it("falls back to 'Untitled' for blank titles", () => {
    expect(normalizeSharedDocumentTitle("   ")).toBe("Untitled");
  });
});

describe("buildSharedDocumentPreview", () => {
  it("returns the default description for empty content", () => {
    expect(buildSharedDocumentPreview("")).toBe(
      "Open this shared document in Mushpot.",
    );
    expect(buildSharedDocumentPreview("   \n\n  ")).toBe(
      "Open this shared document in Mushpot.",
    );
  });

  it("strips markdown syntax down to plain text", () => {
    expect(buildSharedDocumentPreview("# Heading\n\nBody text")).toBe(
      "Heading Body text",
    );
    expect(buildSharedDocumentPreview("![alt text](image.png)")).toBe(
      "alt text",
    );
    expect(buildSharedDocumentPreview("[link label](https://example.com)")).toBe(
      "link label",
    );
    expect(buildSharedDocumentPreview("> a quoted line")).toBe("a quoted line");
    expect(buildSharedDocumentPreview("- a list item")).toBe("a list item");
    expect(buildSharedDocumentPreview("`inline code`")).toBe("inline code");
    expect(buildSharedDocumentPreview("**bold** and _italic_")).toBe(
      "bold and italic",
    );
    expect(buildSharedDocumentPreview("| Col A | Col B |")).toBe("Col A Col B");
  });

  it("returns short content unchanged", () => {
    expect(buildSharedDocumentPreview("just short")).toBe("just short");
  });

  it("truncates long content at a word boundary with an ellipsis", () => {
    expect(buildSharedDocumentPreview("one two three four five", 10)).toBe(
      "one two…",
    );
  });
});
