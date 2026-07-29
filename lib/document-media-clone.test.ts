import { describe, expect, it } from "vitest";

import { planDocumentMediaClone } from "@/lib/document-media-clone";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const DESTINATION_DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const SUPABASE_URL = "https://project-ref.supabase.co";

function plan(content: string) {
  return planDocumentMediaClone({
    content,
    destinationDocumentId: DESTINATION_DOCUMENT_ID,
    ownerId: OWNER_ID,
    supabaseUrl: SUPABASE_URL,
  });
}

describe("planDocumentMediaClone", () => {
  it("copies and rewrites stable image, video, and poster references", () => {
    const image =
      `/m/document-images/${OWNER_ID}/${SOURCE_DOCUMENT_ID}/my%20photo%20%281%29.png`;
    const video =
      `${SUPABASE_URL}/storage/v1/object/public/document-videos/` +
      `${OWNER_ID}/${SOURCE_DOCUMENT_ID}/clip%20one.mp4`;
    const poster =
      `https://project-ref.storage.supabase.co/storage/v1/object/public/` +
      `document-images/${OWNER_ID}/${SOURCE_DOCUMENT_ID}/clip%20poster.jpg`;
    const result = plan(
      `![photo](${image})\n![clip](${video} "poster=${poster}")`,
    );

    expect(result.copies).toEqual([
      {
        bucket: "document-images",
        destinationPath:
          `${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/${SOURCE_DOCUMENT_ID}/` +
          "my photo (1).png",
        sourcePath: `${OWNER_ID}/${SOURCE_DOCUMENT_ID}/my photo (1).png`,
      },
      {
        bucket: "document-videos",
        destinationPath:
          `${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/${SOURCE_DOCUMENT_ID}/clip one.mp4`,
        sourcePath: `${OWNER_ID}/${SOURCE_DOCUMENT_ID}/clip one.mp4`,
      },
      {
        bucket: "document-images",
        destinationPath:
          `${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/${SOURCE_DOCUMENT_ID}/clip poster.jpg`,
        sourcePath: `${OWNER_ID}/${SOURCE_DOCUMENT_ID}/clip poster.jpg`,
      },
    ]);
    expect(result.content).toBe(
      `![photo](/m/document-images/${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/` +
        `${SOURCE_DOCUMENT_ID}/my%20photo%20%281%29.png)\n` +
        `![clip](/m/document-videos/${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/` +
        `${SOURCE_DOCUMENT_ID}/clip%20one.mp4 "poster=/m/document-images/` +
        `${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/${SOURCE_DOCUMENT_ID}/` +
        `clip%20poster.jpg")`,
    );
  });

  it("deduplicates equivalent stable and legacy references", () => {
    const stable =
      `/m/document-images/${OWNER_ID}/${SOURCE_DOCUMENT_ID}/%70hoto.png`;
    const legacy =
      `${SUPABASE_URL}/storage/v1/object/public/document-images/` +
      `${OWNER_ID}/${SOURCE_DOCUMENT_ID}/photo.png`;
    const result = plan(`![one](${stable})\n![two](${legacy})`);
    const replacement =
      `/m/document-images/${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/` +
      `${SOURCE_DOCUMENT_ID}/photo.png`;

    expect(result.copies).toHaveLength(1);
    expect(result.copies[0]).toEqual({
      bucket: "document-images",
      destinationPath:
        `${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/${SOURCE_DOCUMENT_ID}/photo.png`,
      sourcePath: `${OWNER_ID}/${SOURCE_DOCUMENT_ID}/photo.png`,
    });
    expect(result.content).toBe(`![one](${replacement})\n![two](${replacement})`);
  });

  it("copies same-owner cross-document media without destination collisions", () => {
    const first =
      `/m/document-images/${OWNER_ID}/${SOURCE_DOCUMENT_ID}/photo.png`;
    const second =
      `/m/document-images/${OWNER_ID}/${OTHER_DOCUMENT_ID}/photo.png`;
    const result = plan(`![one](${first})\n![two](${second})`);

    expect(result.copies.map((copy) => copy.destinationPath)).toEqual([
      `${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/${SOURCE_DOCUMENT_ID}/photo.png`,
      `${OWNER_ID}/${DESTINATION_DOCUMENT_ID}/${OTHER_DOCUMENT_ID}/photo.png`,
    ]);
    expect(new Set(result.copies.map((copy) => copy.destinationPath)).size).toBe(2);
  });

  it("leaves foreign-owner, external, and malformed references unchanged", () => {
    const content = [
      `![foreign](/m/document-images/${OTHER_OWNER_ID}/${SOURCE_DOCUMENT_ID}/x.png)`,
      "![external](https://cdn.example.com/x.png)",
      `![traversal](/m/document-images/${OWNER_ID}/${SOURCE_DOCUMENT_ID}/%2E%2E/x.png)`,
      `![slash](/m/document-images/${OWNER_ID}/${SOURCE_DOCUMENT_ID}/a%2Fb.png)`,
    ].join("\n");

    expect(plan(content)).toEqual({ content, copies: [] });
  });
});
