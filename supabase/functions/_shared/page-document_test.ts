import { assertEquals, assertRejects, assertThrows } from "@std/assert";

import {
  EdgePageDocumentValidationError,
  getEdgePageDocumentMedia,
  HTML_CONTENT_FORMAT,
  MARKDOWN_CONTENT_FORMAT,
  PAGE_JSON_CONTENT_FORMAT,
  parseEdgePageDocument,
  parsePersistedDocumentContentFormat,
  rewriteEdgePageDocumentMedia,
} from "./page-document.ts";

function page(blocks: unknown[]) {
  return JSON.stringify({
    schema: "mushpot.page",
    version: 1,
    theme: "paper",
    width: "prose",
    content: { type: "doc", content: blocks },
  });
}

Deno.test("persisted content formats default only an absent legacy value", () => {
  assertEquals(
    parsePersistedDocumentContentFormat(undefined),
    MARKDOWN_CONTENT_FORMAT,
  );
  assertEquals(
    parsePersistedDocumentContentFormat(PAGE_JSON_CONTENT_FORMAT),
    PAGE_JSON_CONTENT_FORMAT,
  );
  assertEquals(
    parsePersistedDocumentContentFormat(HTML_CONTENT_FORMAT),
    HTML_CONTENT_FORMAT,
  );
  assertEquals(parsePersistedDocumentContentFormat(null), null);
  assertEquals(parsePersistedDocumentContentFormat("future_json_v2"), null);
});

Deno.test("page media traversal visits only typed image and video attributes", async () => {
  const content = page([
    {
      type: "image",
      attrs: {
        src: "/m/document-images/owner/document/photo.webp",
        alt: "Photo",
      },
    },
    {
      type: "video",
      attrs: {
        src: "/m/document-videos/owner/document/demo.mp4",
        poster: "/m/document-images/owner/document/poster.webp",
      },
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "/m/document-images/owner/document/mentioned.webp",
        },
      ],
    },
  ]);

  assertEquals(
    getEdgePageDocumentMedia(content).map(({ attribute, nodeType, url }) => ({
      attribute,
      nodeType,
      url,
    })),
    [
      {
        attribute: "src",
        nodeType: "image",
        url: "/m/document-images/owner/document/photo.webp",
      },
      {
        attribute: "src",
        nodeType: "video",
        url: "/m/document-videos/owner/document/demo.mp4",
      },
      {
        attribute: "poster",
        nodeType: "video",
        url: "/m/document-images/owner/document/poster.webp",
      },
    ],
  );

  const rewritten = await rewriteEdgePageDocumentMedia(
    content,
    ({ url }) => url.replace("/m/", "/shared/"),
  );
  assertEquals(
    getEdgePageDocumentMedia(rewritten).map(({ url }) => url),
    [
      "/shared/document-images/owner/document/photo.webp",
      "/shared/document-videos/owner/document/demo.mp4",
      "/shared/document-images/owner/document/poster.webp",
    ],
  );
  assertEquals(
    JSON.stringify(parseEdgePageDocument(rewritten)).includes(
      "/m/document-images/owner/document/mentioned.webp",
    ),
    true,
  );
});

Deno.test("page parsing rejects unknown structure and unsafe media", () => {
  const invalid = [
    "{",
    page([{ type: "iframe", attrs: { src: "https://example.com" } }]),
    page([{
      type: "video",
      attrs: { src: "https://example.com/a.mp4", autoplay: true },
    }]),
    page([{ type: "image", attrs: { src: "javascript:alert(1)" } }]),
    JSON.stringify({
      schema: "mushpot.page",
      version: 2,
      theme: "paper",
      width: "prose",
      content: { type: "doc", content: [{ type: "paragraph" }] },
    }),
  ];

  for (const content of invalid) {
    assertThrows(
      () => parseEdgePageDocument(content),
      EdgePageDocumentValidationError,
    );
  }
});

Deno.test("page rewriting validates replacement URLs", async () => {
  const content = page([{
    type: "image",
    attrs: { src: "https://example.com/photo.webp" },
  }]);
  await assertRejects(
    () => rewriteEdgePageDocumentMedia(content, () => "data:text/html,bad"),
    EdgePageDocumentValidationError,
  );
});
