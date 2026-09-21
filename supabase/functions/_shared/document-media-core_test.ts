import { assertEquals, assertThrows } from "@std/assert";
import {
  buildDocumentMediaUrl,
  encodeDocumentMediaPath,
  parseDocumentMediaCandidate,
  parseDocumentMediaUrl,
} from "./document-media-core.ts";
import {
  DOCUMENT_MEDIA_ENCODING_FIXTURES,
  DOCUMENT_MEDIA_INVALID_PATH_FIXTURES,
  DOCUMENT_MEDIA_PARSE_FIXTURES,
  MEDIA_FIXTURE_DOCUMENT,
  MEDIA_FIXTURE_OWNER,
} from "./document-media-core.fixtures.ts";
import { parseSharedDocumentMediaReference } from "./document-media.ts";

for (const fixture of DOCUMENT_MEDIA_PARSE_FIXTURES) {
  Deno.test(`media parser: ${fixture.name}`, () => {
    const parsed = parseDocumentMediaCandidate(
      fixture.url,
      fixture.supabaseUrl,
    );
    assertEquals(parsed, fixture.expected);
    const media = fixture.expected.status === "media"
      ? fixture.expected.media
      : null;
    assertEquals(
      parseDocumentMediaUrl(fixture.url, fixture.supabaseUrl),
      media,
    );
    assertEquals(
      parseSharedDocumentMediaReference(fixture.url, {
        documentId: MEDIA_FIXTURE_DOCUMENT,
        ownerId: MEDIA_FIXTURE_OWNER,
        supabaseUrl: fixture.supabaseUrl ?? "",
      }),
      media?.ownerId === MEDIA_FIXTURE_OWNER &&
        media.documentId === MEDIA_FIXTURE_DOCUMENT
        ? { bucket: media.bucket, path: media.storagePath }
        : null,
    );
  });
}
for (const fixture of DOCUMENT_MEDIA_ENCODING_FIXTURES) {
  Deno.test(`media encoding: ${fixture.path}`, () => {
    assertEquals(encodeDocumentMediaPath(fixture.path), fixture.encoded);
    assertEquals(
      buildDocumentMediaUrl("document-images", fixture.path),
      `/m/document-images/${fixture.encoded}`,
    );
  });
}
for (const path of DOCUMENT_MEDIA_INVALID_PATH_FIXTURES) {
  Deno.test(`reject invalid media path: ${JSON.stringify(path)}`, () => {
    assertThrows(
      () => encodeDocumentMediaPath(path),
      Error,
      "Invalid document media path",
    );
  });
}
