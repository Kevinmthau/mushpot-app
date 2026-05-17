import { describe, expect, it } from "vitest";

import {
  normalizeMarkdownImageWidth,
  parseImageWidthTokenFromText,
} from "@/lib/markdown/image-width";

describe("normalizeMarkdownImageWidth", () => {
  it("defaults a unitless value to pixels", () => {
    expect(normalizeMarkdownImageWidth("300")).toBe("300px");
  });

  it("preserves explicit px and % units", () => {
    expect(normalizeMarkdownImageWidth("300px")).toBe("300px");
    expect(normalizeMarkdownImageWidth("50%")).toBe("50%");
    expect(normalizeMarkdownImageWidth("100%")).toBe("100%");
  });

  it("rejects percentages above 100", () => {
    expect(normalizeMarkdownImageWidth("150%")).toBeNull();
  });

  it("rejects zero and negative values", () => {
    expect(normalizeMarkdownImageWidth("0")).toBeNull();
    expect(normalizeMarkdownImageWidth("-5")).toBeNull();
  });

  it("strips trailing zeros from fractional values", () => {
    expect(normalizeMarkdownImageWidth("12.500")).toBe("12.5px");
    expect(normalizeMarkdownImageWidth("12.000")).toBe("12px");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeMarkdownImageWidth("  300PX  ")).toBe("300px");
  });

  it("returns null for non-numeric input", () => {
    expect(normalizeMarkdownImageWidth("wide")).toBeNull();
    expect(normalizeMarkdownImageWidth("")).toBeNull();
  });
});

describe("parseImageWidthTokenFromText", () => {
  it("parses a leading {width=...} token and reports consumed length", () => {
    const result = parseImageWidthTokenFromText("{width=300}rest of line");
    expect(result).toEqual({ consumedChars: 11, width: "300px" });
  });

  it("accepts internal whitespace and percentage units", () => {
    const result = parseImageWidthTokenFromText("{ width = 50% } trailing");
    expect(result?.width).toBe("50%");
    expect(result?.consumedChars).toBe("{ width = 50% }".length);
  });

  it("returns null when no token is present", () => {
    expect(parseImageWidthTokenFromText("just some text")).toBeNull();
  });

  it("returns null when the token holds an invalid width", () => {
    expect(parseImageWidthTokenFromText("{width=0}")).toBeNull();
    expect(parseImageWidthTokenFromText("{width=999%}")).toBeNull();
  });
});
