import { describe, expect, it, vi } from "vitest";

import {
  buildHtmlPreviewDocument,
  decodeHtmlDocumentBytes,
  decodeHtmlDocumentFile,
  getHtmlDocumentMetadata,
  getHtmlImportTitle,
  getHtmlPreviewCsp,
  HTML_CONTENT_MAX_BYTES,
  HTML_PREVIEW_SANDBOX,
  validateHtmlDocumentSource,
} from "@/lib/html-document";

describe("HTML document import", () => {
  it("decodes valid UTF-8 exactly and preserves a BOM", () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("<!doctype html><p>Flourish — café</p>"),
    ]);
    const source = decodeHtmlDocumentBytes(bytes);

    expect(source.charCodeAt(0)).toBe(0xfeff);
    expect(new TextEncoder().encode(source)).toEqual(bytes);
  });

  it.each([
    { bytes: new Uint8Array(), message: "cannot be empty" },
    { bytes: new Uint8Array([0xc3, 0x28]), message: "valid UTF-8" },
    { bytes: new TextEncoder().encode("<p>before\0after</p>"), message: "NUL" },
  ])("rejects invalid input: $message", ({ bytes, message }) => {
    expect(() => decodeHtmlDocumentBytes(bytes)).toThrow(message);
  });

  it("rejects oversized files before reading them into memory", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));

    await expect(decodeHtmlDocumentFile({
      arrayBuffer,
      size: HTML_CONTENT_MAX_BYTES + 1,
    })).rejects.toThrow("2 MiB");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects strings that cannot round-trip through UTF-8", () => {
    expect(() => validateHtmlDocumentSource("<p>\ud800</p>"))
      .toThrow("valid UTF-8");
  });

  it("accepts the exact 2 MiB boundary and rejects one byte more", () => {
    const prefix = "<!doctype html><p>";
    const suffix = "</p>";
    const exact = prefix + "a".repeat(
      HTML_CONTENT_MAX_BYTES - prefix.length - suffix.length,
    ) + suffix;

    expect(validateHtmlDocumentSource(exact)).toBe(exact);
    expect(() => validateHtmlDocumentSource(`${exact}a`)).toThrow("2 MiB");
  });

  it("extracts the title and falls back to the filename", () => {
    expect(getHtmlImportTitle(
      "<!doctype html><html><head><title> Flourish &amp; Beyond </title></head></html>",
      "fallback.html",
    )).toBe("Flourish & Beyond");
    expect(getHtmlImportTitle("<p>No title</p>", "Archive.v1.html")).toBe(
      "Archive.v1",
    );
  });
});

describe("HTML metadata projection", () => {
  it("prefers description and ignores hidden, template, and license text", () => {
    const source = `<!doctype html><html><head>
      <title>Document title</title>
      <meta name="description" content="  Preferred   summary.  ">
      <style>style words</style><script>script words</script>
    </head><body>
      <main><h1>Visible heading</h1><p>Visible body.</p></main>
      <noscript>noscript words</noscript>
      <template>template words</template>
      <section id="license">Very long license words</section>
    </body></html>`;

    expect(getHtmlDocumentMetadata(source)).toEqual({
      title: "Document title",
      description: "Preferred summary.",
      visibleText: "Visible heading\nVisible body.",
    });
  });
});

describe("HTML preview hardening", () => {
  it("puts the inner CSP before author nodes and removes base/refresh navigation", () => {
    const source = `<!doctype html><html><head data-marker=">"><base href="https://example.com/">
      <meta http-equiv="refresh" content="0;url=https://example.com/">
      <script>window.ran = true</script></head><body><form action="https://example.com/">
      <iframe src="https://example.com/"></iframe><object data="data:text/plain,x"></object>
      </form></body></html>`;
    const preview = buildHtmlPreviewDocument(source);

    expect(preview.indexOf("Content-Security-Policy")).toBeLessThan(
      preview.indexOf("<script>"),
    );
    expect(preview).toContain(
      '<head data-marker=">"><meta http-equiv="Content-Security-Policy"',
    );
    expect(preview).not.toContain("<base");
    expect(preview).not.toContain("http-equiv=\"refresh\"");
    expect(preview).toContain("script-src 'none'");
    expect(preview).toContain("connect-src 'none'");
    expect(preview).toContain("form-action 'none'");
    expect(preview).toContain("frame-src 'none'");
    expect(preview).toContain("object-src 'none'");
    expect(source).toContain("<base href=");
  });

  it("keeps scripts disabled in every preview", () => {
    expect(getHtmlPreviewCsp()).toContain("script-src 'none'");
    expect(getHtmlPreviewCsp()).toContain("connect-src 'none'");
    expect(HTML_PREVIEW_SANDBOX).toBe("");
  });
});
