import { describe, expect, it, vi } from "vitest";

import {
  buildSharedDocumentMediaUrl,
  parseSharedDocumentMediaReference,
  rewriteSharedDocumentMediaUrls,
  sharedDocumentContentReferencesMedia,
} from "./document-media";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const SUPABASE_URL = "https://project-ref.supabase.co";
const SHARE_TOKEN = "a".repeat(64);
const OPTIONS = {
  documentId: DOCUMENT_ID,
  ownerId: OWNER_ID,
  supabaseUrl: SUPABASE_URL,
};

describe("parseSharedDocumentMediaReference", () => {
  it("parses stable and legacy document-owned media URLs", () => {
    const path = `${OWNER_ID}/${DOCUMENT_ID}/my%20photo.png`;

    expect(
      parseSharedDocumentMediaReference(
        `/m/document-images/${path}`,
        OPTIONS,
      ),
    ).toEqual({
      bucket: "document-images",
      path: `${OWNER_ID}/${DOCUMENT_ID}/my photo.png`,
    });
    expect(
      parseSharedDocumentMediaReference(
        `${SUPABASE_URL}/storage/v1/object/public/document-videos/${OWNER_ID}/${DOCUMENT_ID}/clip.mp4`,
        OPTIONS,
      ),
    ).toEqual({
      bucket: "document-videos",
      path: `${OWNER_ID}/${DOCUMENT_ID}/clip.mp4`,
    });
  });

  it("accepts same-owner cross-document media and rejects foreign origins", () => {
    expect(
      parseSharedDocumentMediaReference(
        `/m/document-images/${OWNER_ID}/${OTHER_DOCUMENT_ID}/photo.png`,
        OPTIONS,
      ),
    ).toEqual({
      bucket: "document-images",
      path: `${OWNER_ID}/${OTHER_DOCUMENT_ID}/photo.png`,
    });
    expect(
      parseSharedDocumentMediaReference(
        `https://evil.example/storage/v1/object/public/document-images/${OWNER_ID}/${DOCUMENT_ID}/photo.png`,
        OPTIONS,
      ),
    ).toBeNull();
  });
});

describe("buildSharedDocumentMediaUrl", () => {
  it("builds a share-scoped URL with encoded storage path segments", () => {
    expect(
      buildSharedDocumentMediaUrl({
        documentId: DOCUMENT_ID,
        reference: {
          bucket: "document-images",
          path: `${OWNER_ID}/${DOCUMENT_ID}/my photo (1).png`,
        },
        token: SHARE_TOKEN,
      }),
    ).toBe(
      `/s/${DOCUMENT_ID}/${SHARE_TOKEN}/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/my%20photo%20%281%29.png`,
    );
  });

  it("keeps a legacy source document ID inside the share-scoped route", () => {
    expect(
      buildSharedDocumentMediaUrl({
        documentId: DOCUMENT_ID,
        reference: {
          bucket: "document-images",
          path: `${OWNER_ID}/${OTHER_DOCUMENT_ID}/photo.png`,
        },
        token: SHARE_TOKEN,
      }),
    ).toBe(
      `/s/${DOCUMENT_ID}/${SHARE_TOKEN}/m/document-images/` +
        `${OWNER_ID}/${OTHER_DOCUMENT_ID}/photo.png`,
    );
  });
});

describe("sharedDocumentContentReferencesMedia", () => {
  it("allows an exact cross-document media reference present in the content", () => {
    const reference = {
      bucket: "document-images" as const,
      path: `${OWNER_ID}/${OTHER_DOCUMENT_ID}/photo.png`,
    };

    expect(
      sharedDocumentContentReferencesMedia(
        `![legacy clone](/m/document-images/${reference.path})`,
        reference,
        OPTIONS,
      ),
    ).toBe(true);
  });

  it("does not authorize an unreferenced object from the same owner", () => {
    const referencedPath = `${OWNER_ID}/${OTHER_DOCUMENT_ID}/photo.png`;
    const requestedPath = `${OWNER_ID}/${OTHER_DOCUMENT_ID}/private.png`;

    expect(
      sharedDocumentContentReferencesMedia(
        `![legacy clone](/m/document-images/${referencedPath})`,
        { bucket: "document-images", path: requestedPath },
        OPTIONS,
      ),
    ).toBe(false);
  });
});

describe("rewriteSharedDocumentMediaUrls", () => {
  it("resolves owned media, including poster URLs, and preserves external URLs", async () => {
    const imagePath = `${OWNER_ID}/${DOCUMENT_ID}/photo.png`;
    const videoPath = `${OWNER_ID}/${DOCUMENT_ID}/clip.mp4`;
    const content = [
      `![photo](/m/document-images/${imagePath})`,
      `![clip](${SUPABASE_URL}/storage/v1/object/public/document-videos/${videoPath} "poster=/m/document-images/${imagePath}")`,
      "![external](https://images.example/photo.png)",
    ].join("\n");
    const resolve = vi.fn(({ bucket, path }) =>
      `/shared-media/${bucket}/${path}`,
    );

    const rewritten = await rewriteSharedDocumentMediaUrls(content, {
      ...OPTIONS,
      resolve,
    });

    expect(rewritten).toContain(
      `/shared-media/document-images/${imagePath}`,
    );
    expect(rewritten).toContain(
      `/shared-media/document-videos/${videoPath}`,
    );
    expect(rewritten).toContain("https://images.example/photo.png");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps one failed media URL without failing the document", async () => {
    const imagePath = `${OWNER_ID}/${DOCUMENT_ID}/missing.png`;
    const videoPath = `${OWNER_ID}/${DOCUMENT_ID}/clip.mp4`;
    const imageUrl = `/m/document-images/${imagePath}`;
    const videoUrl = `/m/document-videos/${videoPath}`;

    const rewritten = await rewriteSharedDocumentMediaUrls(
      `![missing](${imageUrl})\n![video](${videoUrl})`,
      {
        ...OPTIONS,
        resolve: ({ bucket }) => {
          if (bucket === "document-images") {
            throw new Error("missing object");
          }

          return "/shared-media/video";
        },
      },
    );

    expect(rewritten).toContain(imageUrl);
    expect(rewritten).toContain("/shared-media/video");
  });

  it("rewrites media retained from a pre-migration clone", async () => {
    const sourcePath = `${OWNER_ID}/${OTHER_DOCUMENT_ID}/photo.png`;

    const rewritten = await rewriteSharedDocumentMediaUrls(
      `![legacy clone](/m/document-images/${sourcePath})`,
      {
        ...OPTIONS,
        resolve: (reference) =>
          buildSharedDocumentMediaUrl({
            documentId: DOCUMENT_ID,
            reference,
            token: SHARE_TOKEN,
          }),
      },
    );

    expect(rewritten).toContain(
      `/s/${DOCUMENT_ID}/${SHARE_TOKEN}/m/document-images/${sourcePath}`,
    );
  });
});
