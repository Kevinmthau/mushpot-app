import { describe, expect, it } from "vitest";

import {
  buildDocumentMediaUrl,
  normalizeDocumentMediaUrl,
  parseDocumentMediaRoute,
  parseDocumentMediaUrl,
} from "@/lib/document-media";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const SUPABASE_URL = "https://project-ref.supabase.co";

describe("buildDocumentMediaUrl", () => {
  it("builds an encoded same-origin media path", () => {
    expect(
      buildDocumentMediaUrl(
        "document-images",
        `${OWNER_ID}/${DOCUMENT_ID}/my photo.png`,
      ),
    ).toBe(
      `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/my%20photo.png`,
    );
  });

  it("rejects traversal-like storage paths", () => {
    expect(() =>
      buildDocumentMediaUrl(
        "document-images",
        `${OWNER_ID}/${DOCUMENT_ID}/../secret.png`,
      ),
    ).toThrow("Invalid document media path");
  });

  it("keeps Markdown-sensitive filename characters percent encoded", () => {
    expect(
      buildDocumentMediaUrl(
        "document-images",
        `${OWNER_ID}/${DOCUMENT_ID}/it's (mine).png`,
      ),
    ).toBe(
      `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/it%27s%20%28mine%29.png`,
    );
  });
});

describe("parseDocumentMediaRoute", () => {
  it("parses an owner/document scoped route", () => {
    expect(
      parseDocumentMediaRoute("document-videos", [
        OWNER_ID,
        DOCUMENT_ID,
        "clip.mp4",
      ]),
    ).toEqual({
      bucket: "document-videos",
      documentId: DOCUMENT_ID,
      ownerId: OWNER_ID,
      storagePath: `${OWNER_ID}/${DOCUMENT_ID}/clip.mp4`,
    });
  });

  it("rejects unknown buckets and malformed identifiers", () => {
    expect(
      parseDocumentMediaRoute("avatars", [OWNER_ID, DOCUMENT_ID, "x.png"]),
    ).toBeNull();
    expect(
      parseDocumentMediaRoute("document-images", [
        "not-a-user",
        DOCUMENT_ID,
        "x.png",
      ]),
    ).toBeNull();
  });
});

describe("parseDocumentMediaUrl", () => {
  it("parses stable and legacy URLs into decoded storage paths", () => {
    const stable =
      `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/my%20photo%20%281%29.png`;
    const expected = {
      bucket: "document-images",
      documentId: DOCUMENT_ID,
      ownerId: OWNER_ID,
      storagePath: `${OWNER_ID}/${DOCUMENT_ID}/my photo (1).png`,
    };

    expect(parseDocumentMediaUrl(stable, SUPABASE_URL)).toEqual(expected);
    expect(
      parseDocumentMediaUrl(
        `${SUPABASE_URL}/storage/v1/object/public/document-images/` +
          `${OWNER_ID}/${DOCUMENT_ID}/my%20photo%20%281%29.png`,
        SUPABASE_URL,
      ),
    ).toEqual(expected);
  });

  it("rejects encoded traversal and path separators", () => {
    expect(
      parseDocumentMediaUrl(
        `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/%2E%2E/x.png`,
        SUPABASE_URL,
      ),
    ).toBeNull();
    expect(
      parseDocumentMediaUrl(
        `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/a%2Fb.png`,
        SUPABASE_URL,
      ),
    ).toBeNull();
  });
});

describe("normalizeDocumentMediaUrl", () => {
  it("converts legacy project and storage-host public URLs", () => {
    const path = `${OWNER_ID}/${DOCUMENT_ID}/photo.png`;

    expect(
      normalizeDocumentMediaUrl(
        `${SUPABASE_URL}/storage/v1/object/public/document-images/${path}`,
        SUPABASE_URL,
      ),
    ).toBe(`/m/document-images/${path}`);
    expect(
      normalizeDocumentMediaUrl(
        `https://project-ref.storage.supabase.co/storage/v1/object/public/document-images/${path}`,
        SUPABASE_URL,
      ),
    ).toBe(`/m/document-images/${path}`);
  });

  it("leaves stable, external, and unrelated URLs unchanged", () => {
    const stable = `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/photo.png`;
    expect(normalizeDocumentMediaUrl(stable, SUPABASE_URL)).toBe(stable);
    expect(
      normalizeDocumentMediaUrl(
        `https://evil.example/storage/v1/object/public/document-images/${OWNER_ID}/${DOCUMENT_ID}/photo.png`,
        SUPABASE_URL,
      ),
    ).toContain("https://evil.example/");
    expect(
      normalizeDocumentMediaUrl(`${SUPABASE_URL}/other/path.png`, SUPABASE_URL),
    ).toBe(`${SUPABASE_URL}/other/path.png`);
  });
});
