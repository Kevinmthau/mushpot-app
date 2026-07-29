import { assertEquals } from "@std/assert";

import {
  handleSharedDocumentRequest,
  type SharedDocumentOperations,
} from "./handler.ts";

const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const SHARE_TOKEN = "a".repeat(64);
const SUPABASE_URL = "https://example-project.supabase.co";
const REFERENCED_MEDIA_URL =
  `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/referenced.png`;
const UNREFERENCED_MEDIA_URL =
  `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/unreferenced.png`;

type SignedUrlCall = {
  bucket: "document-images" | "document-videos";
  expiresIn: number;
  path: string;
};

function createHarness() {
  const signedUrlCalls: SignedUrlCall[] = [];
  const operations: SharedDocumentOperations = {
    createSignedUrl: (bucket, path, expiresIn) => {
      signedUrlCalls.push({ bucket, expiresIn, path });
      return Promise.resolve({
        data: { signedUrl: "https://signed.example/referenced.png" },
        error: null,
      });
    },
    getSharedDocument: (docId, token) =>
      Promise.resolve({
        data: docId === DOCUMENT_ID && token === SHARE_TOKEN
          ? {
            content: `![Referenced image](${REFERENCED_MEDIA_URL})`,
            owner: OWNER_ID,
            title: "Shared document",
            updated_at: "2026-07-29T12:00:00.000Z",
          }
          : null,
        error: null,
      }),
  };

  return {
    dependencies: {
      createOperations: () => operations,
      getEnvironmentValue: (name: string) => {
        if (name === "SUPABASE_URL") {
          return SUPABASE_URL;
        }
        if (name === "SUPABASE_SERVICE_ROLE_KEY") {
          return "test-service-role-key";
        }
        return undefined;
      },
    },
    signedUrlCalls,
  };
}

function createMediaRequest(mediaUrl: string) {
  return new Request("https://functions.example/get-shared-doc", {
    body: JSON.stringify({
      docId: DOCUMENT_ID,
      mediaUrl,
      token: SHARE_TOKEN,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

Deno.test(
  "valid shares cannot sign an unreferenced same-document object",
  async () => {
    const { dependencies, signedUrlCalls } = createHarness();
    const response = await handleSharedDocumentRequest(
      createMediaRequest(UNREFERENCED_MEDIA_URL),
      dependencies,
    );

    assertEquals(response.status, 404);
    assertEquals(await response.json(), { error: "Media not found." });
    assertEquals(signedUrlCalls, []);
  },
);

Deno.test("valid shares can sign an exactly referenced object", async () => {
  const { dependencies, signedUrlCalls } = createHarness();
  const response = await handleSharedDocumentRequest(
    createMediaRequest(REFERENCED_MEDIA_URL),
    dependencies,
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    signedUrl: "https://signed.example/referenced.png",
  });
  assertEquals(signedUrlCalls, [{
    bucket: "document-images",
    expiresIn: 300,
    path: `${OWNER_ID}/${DOCUMENT_ID}/referenced.png`,
  }]);
});
