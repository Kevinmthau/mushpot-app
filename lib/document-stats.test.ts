import { describe, expect, it } from "vitest";

import {
  countWords,
  estimateReadingTime,
  getReadingTimeFromText,
} from "@/lib/document-stats";

describe("countWords", () => {
  it("returns 0 for empty or whitespace-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t  ")).toBe(0);
  });

  it("counts words separated by arbitrary whitespace", () => {
    expect(countWords("hello")).toBe(1);
    expect(countWords("hello world")).toBe(2);
    expect(countWords("  one   two\nthree\tfour  ")).toBe(4);
  });
});

describe("estimateReadingTime", () => {
  it("returns 0 for an empty document", () => {
    expect(estimateReadingTime(0)).toBe(0);
  });

  it("floors any non-empty document to at least 1 minute", () => {
    expect(estimateReadingTime(1)).toBe(1);
    expect(estimateReadingTime(225)).toBe(1);
  });

  it("rounds up at the 225-words-per-minute boundary", () => {
    expect(estimateReadingTime(226)).toBe(2);
    expect(estimateReadingTime(450)).toBe(2);
    expect(estimateReadingTime(451)).toBe(3);
  });
});

describe("getReadingTimeFromText", () => {
  it("composes word counting and reading-time estimation", () => {
    expect(getReadingTimeFromText("")).toBe(0);
    expect(getReadingTimeFromText("a few words here")).toBe(1);
  });
});
