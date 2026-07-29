import { assertEquals, assertStringIncludes } from "@std/assert";

import { analyzeDocumentMedia } from "./document-media-backfill.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const DOCUMENT = "22222222-2222-4222-8222-222222222222";
const SOURCE_DOCUMENT = "33333333-3333-4333-8333-333333333333";
const OTHER_OWNER = "44444444-4444-4444-8444-444444444444";
const SUPABASE_URL = "https://project-ref.supabase.co";

Deno.test("rewrites same-document legacy media without copying", () => {
  const legacy = `${SUPABASE_URL}/storage/v1/object/public/document-images/` +
    `${OWNER}/${DOCUMENT}/cover%20image.png`;
  const analysis = analyzeDocumentMedia({
    content: `![cover](${legacy})`,
    documentId: DOCUMENT,
    ownerId: OWNER,
    supabaseUrl: SUPABASE_URL,
  });

  assertEquals(analysis.blockers, []);
  assertEquals(analysis.copies, []);
  assertEquals(
    analysis.rewrittenContent,
    `![cover](/m/document-images/${OWNER}/${DOCUMENT}/cover%20image.png)`,
  );
});

Deno.test("plans deterministic document-owned copies", () => {
  const source = `/m/document-videos/${OWNER}/${SOURCE_DOCUMENT}/clip.mp4`;
  const analysis = analyzeDocumentMedia({
    content:
      `![clip](${source} "poster=/m/document-images/${OWNER}/${SOURCE_DOCUMENT}/poster.jpg")`,
    documentId: DOCUMENT,
    ownerId: OWNER,
    supabaseUrl: SUPABASE_URL,
  });

  assertEquals(analysis.blockers, []);
  assertEquals(analysis.copies, [
    {
      bucket: "document-videos",
      destinationPath: `${OWNER}/${DOCUMENT}/${SOURCE_DOCUMENT}/clip.mp4`,
      sourcePath: `${OWNER}/${SOURCE_DOCUMENT}/clip.mp4`,
    },
    {
      bucket: "document-images",
      destinationPath: `${OWNER}/${DOCUMENT}/${SOURCE_DOCUMENT}/poster.jpg`,
      sourcePath: `${OWNER}/${SOURCE_DOCUMENT}/poster.jpg`,
    },
  ]);
  assertStringIncludes(
    analysis.rewrittenContent,
    `/m/document-videos/${OWNER}/${DOCUMENT}/${SOURCE_DOCUMENT}/clip.mp4`,
  );
  assertStringIncludes(
    analysis.rewrittenContent,
    `/m/document-images/${OWNER}/${DOCUMENT}/${SOURCE_DOCUMENT}/poster.jpg`,
  );
});

Deno.test("blocks cross-owner and malformed media paths", () => {
  const analysis = analyzeDocumentMedia({
    content: [
      `![foreign](/m/document-images/${OTHER_OWNER}/${DOCUMENT}/x.png)`,
      "![bad](/m/document-images/not-a-uuid/bad)",
    ].join("\n"),
    documentId: DOCUMENT,
    ownerId: OWNER,
    supabaseUrl: SUPABASE_URL,
  });

  assertEquals(analysis.blockers.length, 2);
  assertStringIncludes(analysis.blockers[0], "Cross-owner");
  assertStringIncludes(analysis.blockers[1], "Malformed");
});

Deno.test("ignores unrelated external URLs", () => {
  const content = "![external](https://cdn.example.com/photo.png)";
  const analysis = analyzeDocumentMedia({
    content,
    documentId: DOCUMENT,
    ownerId: OWNER,
    supabaseUrl: SUPABASE_URL,
  });

  assertEquals(analysis, {
    blockers: [],
    copies: [],
    references: [],
    rewrittenContent: content,
  });
});
