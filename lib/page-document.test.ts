import { describe, expect, it } from "vitest";

import { renderPageDocumentHtml } from "@/components/editor/page-editor-extensions";
import {
  HTML_CONTENT_FORMAT,
  canonicalizePageDocument,
  createEmptyPageDocument,
  EMPTY_PAGE_DOCUMENT_CONTENT,
  getDocumentPlainText,
  getPageDocumentMedia,
  getPageDocumentPlainText,
  MARKDOWN_CONTENT_FORMAT,
  MAX_PAGE_DOCUMENT_DEPTH,
  normalizeDocumentContentFormat,
  PAGE_DOCUMENT_SCHEMA,
  PAGE_DOCUMENT_VERSION,
  PAGE_JSON_CONTENT_FORMAT,
  parseDocumentContentFormat,
  parsePageDocument,
  rewritePageDocumentMedia,
  rewritePageDocumentMediaAsync,
  serializePageDocument,
} from "@/lib/page-document";

function page(content: Record<string, unknown>[]) {
  return {
    schema: PAGE_DOCUMENT_SCHEMA,
    version: PAGE_DOCUMENT_VERSION,
    theme: "paper",
    width: "prose",
    content: { type: "doc", content },
  };
}

describe("page document format", () => {
  it("normalizes only the recognized page format and defaults safely", () => {
    expect(normalizeDocumentContentFormat(PAGE_JSON_CONTENT_FORMAT)).toBe(
      PAGE_JSON_CONTENT_FORMAT,
    );
    expect(normalizeDocumentContentFormat(MARKDOWN_CONTENT_FORMAT)).toBe(
      MARKDOWN_CONTENT_FORMAT,
    );
    expect(normalizeDocumentContentFormat(undefined)).toBe(
      MARKDOWN_CONTENT_FORMAT,
    );
    expect(normalizeDocumentContentFormat(null)).toBe(
      MARKDOWN_CONTENT_FORMAT,
    );
    expect(() => normalizeDocumentContentFormat("future_json_v2")).toThrow(
      /Invalid document content format/u,
    );
    expect(parseDocumentContentFormat(MARKDOWN_CONTENT_FORMAT)).toBe(
      MARKDOWN_CONTENT_FORMAT,
    );
    expect(parseDocumentContentFormat(PAGE_JSON_CONTENT_FORMAT)).toBe(
      PAGE_JSON_CONTENT_FORMAT,
    );
    expect(parseDocumentContentFormat(HTML_CONTENT_FORMAT)).toBe(
      HTML_CONTENT_FORMAT,
    );
    expect(() => parseDocumentContentFormat("future_json_v2")).toThrow(
      /Invalid document content format/u,
    );
  });

  it("projects HTML to visible body text without exposing executable or license text", () => {
    expect(getDocumentPlainText(
      "<!doctype html><html><head><script>secret()</script></head><body><h1>Hello</h1><section class=license>License</section><p>World</p></body></html>",
      HTML_CONTENT_FORMAT,
    )).toBe("Hello\nWorld");
  });

  it("provides deterministic, round-trippable empty content", () => {
    const empty = createEmptyPageDocument();
    expect(serializePageDocument(empty)).toBe(EMPTY_PAGE_DOCUMENT_CONTENT);
    expect(parsePageDocument(EMPTY_PAGE_DOCUMENT_CONTENT)).toEqual(empty);
    expect(EMPTY_PAGE_DOCUMENT_CONTENT).toBe(
      '{"schema":"mushpot.page","version":1,"theme":"paper","width":"prose","content":{"type":"doc","content":[{"type":"paragraph"}]}}',
    );
  });

  it("canonicalizes keys, defaults, and mark order", () => {
    const input = {
      width: "wide",
      content: {
        content: [
          {
            content: [
              {
                text: "Hello",
                marks: [
                  {
                    attrs: {
                      target: "_blank",
                      rel: "noopener noreferrer",
                      class: null,
                      href: "https://example.com",
                    },
                    type: "link",
                  },
                  { type: "bold", attrs: {} },
                ],
                type: "text",
              },
            ],
            attrs: { level: 1 },
            type: "heading",
          },
        ],
        type: "doc",
      },
      theme: "editorial",
      version: 1,
      schema: "mushpot.page",
    };

    const first = serializePageDocument(input);
    const second = serializePageDocument(parsePageDocument(first));
    expect(second).toBe(first);
    expect(JSON.parse(first).content.content[0].content[0].marks).toEqual([
      { type: "bold" },
      { type: "link", attrs: { href: "https://example.com" } },
    ]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["unknown envelope key", JSON.stringify({ ...createEmptyPageDocument(), extra: true })],
    ["unknown schema", JSON.stringify({ ...createEmptyPageDocument(), schema: "other" })],
    ["unknown version", JSON.stringify({ ...createEmptyPageDocument(), version: 2 })],
    ["unknown theme", JSON.stringify({ ...createEmptyPageDocument(), theme: "script" })],
    [
      "unknown node",
      JSON.stringify(page([{ type: "iframe", attrs: { src: "https://example.com" } }])),
    ],
    [
      "unsafe link",
      JSON.stringify(
        page([
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "click",
                marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
              },
            ],
          },
        ]),
      ),
    ],
    [
      "base64 image",
      JSON.stringify(page([{ type: "image", attrs: { src: "data:image/png;base64,AA==" } }])),
    ],
    [
      "invalid nesting",
      JSON.stringify(page([{ type: "paragraph", content: [{ type: "paragraph" }] }])),
    ],
    [
      "unknown media attribute",
      JSON.stringify(
        page([
          {
            type: "video",
            attrs: { src: "https://example.com/a.mp4", autoplay: true },
          },
        ]),
      ),
    ],
  ])("fails closed for %s", (_label, value) => {
    expect(() => parsePageDocument(value)).toThrow(/Invalid page document/u);
  });

  it("bounds nesting before accepting content", () => {
    let nested: Record<string, unknown> = {
      type: "paragraph",
      content: [{ type: "text", text: "deep" }],
    };
    for (let index = 0; index <= MAX_PAGE_DOCUMENT_DEPTH; index += 1) {
      nested = { type: "blockquote", content: [nested] };
    }
    expect(() => canonicalizePageDocument(page([nested]))).toThrow(
      /nested too deeply/u,
    );
  });
});

describe("page document projections", () => {
  const document = page([
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "A page" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "First" },
        { type: "hardBreak" },
        { type: "text", text: "line" },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "One" }] },
          ],
        },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Two" }] },
          ],
        },
      ],
    },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Name" }] },
              ],
            },
            {
              type: "tableHeader",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Value" }] },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "image",
      attrs: {
        src: "/m/document-images/owner/document/photo.webp",
        alt: "A diagram",
        width: 640,
      },
    },
    {
      type: "video",
      attrs: {
        src: "/m/document-videos/owner/document/demo.mp4",
        poster: "/m/document-images/owner/document/poster.webp",
        alt: "A demo",
      },
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "/m/document-images/mentioned-only-in-prose.webp",
          marks: [
            {
              type: "link",
              attrs: { href: "https://example.com/image.webp" },
            },
          ],
        },
      ],
    },
  ]);

  it("extracts semantic plain text", () => {
    expect(getPageDocumentPlainText(document)).toBe(
      [
        "A page",
        "First\nline",
        "One\nTwo",
        "Name\tValue",
        "A diagram",
        "A demo",
        "/m/document-images/mentioned-only-in-prose.webp",
      ].join("\n\n"),
    );
    expect(
      getDocumentPlainText(
        serializePageDocument(document),
        PAGE_JSON_CONTENT_FORMAT,
      ),
    ).toBe(getPageDocumentPlainText(document));
    expect(getDocumentPlainText("# Legacy\n", MARKDOWN_CONTENT_FORMAT)).toBe(
      "# Legacy\n",
    );
  });

  it("finds and rewrites only typed media attributes", async () => {
    expect(getPageDocumentMedia(document)).toEqual([
      {
        nodeType: "image",
        attribute: "src",
        url: "/m/document-images/owner/document/photo.webp",
        path: [4],
      },
      {
        nodeType: "video",
        attribute: "src",
        url: "/m/document-videos/owner/document/demo.mp4",
        path: [5],
      },
      {
        nodeType: "video",
        attribute: "poster",
        url: "/m/document-images/owner/document/poster.webp",
        path: [5],
      },
    ]);

    const rewritten = rewritePageDocumentMedia(document, ({ url }) =>
      url.replace("/m/", "/signed/"),
    );
    expect(getPageDocumentMedia(rewritten).map(({ url }) => url)).toEqual([
      "/signed/document-images/owner/document/photo.webp",
      "/signed/document-videos/owner/document/demo.mp4",
      "/signed/document-images/owner/document/poster.webp",
    ]);
    expect(getPageDocumentPlainText(rewritten)).toContain(
      "/m/document-images/mentioned-only-in-prose.webp",
    );
    expect(getPageDocumentMedia(document)[0].url).toBe(
      "/m/document-images/owner/document/photo.webp",
    );

    const asyncRewritten = await rewritePageDocumentMediaAsync(
      document,
      async ({ url }) => url.replace("/m/", "/async/"),
    );
    expect(getPageDocumentMedia(asyncRewritten)[0].url).toMatch(/^\/async\//u);
    expect(() => rewritePageDocumentMedia(document, () => "javascript:bad"))
      .toThrow(/unsafe media URL/u);
  });
});

describe("page document static HTML", () => {
  it("renders escaped content and controlled media through the editor schema", () => {
    const html = renderPageDocumentHtml(
      page([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "<script>alert(1)</script> " },
            {
              type: "text",
              text: "Example",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.com/?a=1&b=2",
                    target: "_self",
                    rel: "nofollow",
                    class: "source-link",
                  },
                },
              ],
            },
          ],
        },
        {
          type: "image",
          attrs: { src: "https://example.com/image.webp", alt: 'A "photo"' },
        },
        {
          type: "video",
          attrs: {
            src: "https://example.com/video.mp4",
            poster: "https://example.com/poster.webp",
            alt: "Demo",
            width: 720,
          },
        },
      ]),
    );

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("nofollow");
    expect(html).not.toContain("source-link");
    expect(html).toContain('src="https://example.com/image.webp"');
    expect(html).toContain('alt="A &quot;photo&quot;"');
    expect(html).toContain('src="https://example.com/video.mp4"');
    expect(html).toContain('poster="https://example.com/poster.webp"');
    expect(html).toContain('aria-label="Demo"');
    expect(html).toContain('width="720"');
    expect(html).toContain("controls");
  });

  it("rejects unsafe JSON rather than rendering it", () => {
    expect(() =>
      renderPageDocumentHtml(
        page([
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "bad",
                marks: [{ type: "link", attrs: { href: "data:text/html,bad" } }],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/unsafe URL/u);
  });
});
