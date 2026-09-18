import { describe, expect, it } from "vitest";

import { getStandaloneLinkPreviewUrl, normalizeLinkPreviewUrl } from "@/lib/link-preview";

describe("standalone preview URLs", () => {
  it.each([
    ["https://example.com", "https://example.com/"],
    ["https://example.com/a|b", "https://example.com/a%7Cb"],
    ["https://example.com/a_(b)?tag=[x]&copy;=yes", "https://example.com/a_(b)?tag=%5Bx%5D&copy;=yes"],
    ["https://example.com/?tag=[x|y]&value=%26amp;", "https://example.com/?tag=%5Bx%7Cy%5D&value=%26amp;"],
    ["https://[2606:4700:4700::1111]/[a]", "https://[2606:4700:4700::1111]/%5Ba%5D"],
  ])("matches equivalent Markdown label and destination for %s", (label, href) => {
    expect(getStandaloneLinkPreviewUrl(href, label)).toBe(href);
  });

  it.each([
    ["https://example.com", "Example"],
    ["https://example.com", "www.example.com"],
    ["https://example.com/?a=1&b=2", "https://example.com/?a=1%26b=2"],
    ["https://example.com", " https://example.com "],
    ["https://example.com", "https://elsewhere.example.com"],
  ])("preserves a custom or different link label %s %s", (href, label) => {
    expect(getStandaloneLinkPreviewUrl(href, label)).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "mailto:hello@example.com",
    "//example.com",
    "https://user:secret@example.com",
    "https://example.com/has space",
    "https://example.com/has\nnewline",
    "https://example.com/back\\slash",
    "https://",
  ])("rejects unsupported or ambiguous URLs: %s", (value) => {
    expect(normalizeLinkPreviewUrl(value)).toBeNull();
  });
});
