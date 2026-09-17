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
    createSignedUrls: () => Promise.resolve({ data: [], error: null }),
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

function createBatchHarness() {
  const mediaUrls = [
    REFERENCED_MEDIA_URL,
    `/m/document-videos/${OWNER_ID}/${DOCUMENT_ID}/video.mp4`,
  ];
  const calls: Array<{ bucket: string; paths: string[]; expiresIn: number }> =
    [];
  let reads = 0;
  let revoked = false;
  let failImages = false;
  const operations: SharedDocumentOperations = {
    getSharedDocument: () => {
      reads++;
      return Promise.resolve({
        data: revoked ? null : {
          owner: OWNER_ID,
          title: "Batch",
          content: mediaUrls.join("\n"),
          updated_at: "2026-07-29T00:00:00Z",
        },
        error: null,
      });
    },
    createSignedUrl: () => {
      throw new Error("Batch must not sign individually");
    },
    createSignedUrls: (bucket, paths, expiresIn) => {
      calls.push({ bucket, paths, expiresIn });
      return Promise.resolve({
        data: paths.map((path) => ({
          path,
          signedUrl: `${SUPABASE_URL}/signed/${path}`,
          error: failImages && bucket === "document-images" ? "Missing" : null,
        })),
        error: null,
      });
    },
  };
  return {
    calls,
    mediaUrls,
    get reads() {
      return reads;
    },
    revoke() {
      revoked = true;
    },
    failImages() {
      failImages = true;
    },
    request(body: Record<string, unknown>) {
      return handleSharedDocumentRequest(
        new Request("https://functions.example/get-shared-doc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            docId: DOCUMENT_ID,
            token: SHARE_TOKEN,
            ...body,
          }),
        }),
        {
          createOperations: () => operations,
          getEnvironmentValue: (name) =>
            name === "SUPABASE_URL" ? SUPABASE_URL : "test-key",
        },
      );
    },
  };
}

Deno.test("batch signs distinct authorized paths once per bucket with one document read", async () => {
  const harness = createBatchHarness();
  const response = await harness.request({
    mediaUrls: [...harness.mediaUrls, harness.mediaUrls[0]],
  });
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("Cache-Control"),
    "private, no-store, max-age=0",
  );
  assertEquals(harness.reads, 1);
  assertEquals(harness.calls.length, 2);
  assertEquals(harness.calls.map((call) => call.paths.length), [1, 1]);
  assertEquals(harness.calls.map((call) => call.expiresIn), [300, 300]);
  const body = await response.json();
  assertEquals(body.urls.length, 2);
  assertEquals(body.expiresIn, 300);
  assertEquals(
    body.urls.every((item: { signedUrl: unknown }) =>
      typeof item.signedUrl === "string"
    ),
    true,
  );
});

Deno.test("mixed batches never sign invalid, foreign, or unreferenced paths", async () => {
  const harness = createBatchHarness();
  const invalid = [
    UNREFERENCED_MEDIA_URL,
    "https://external.example/image.png",
    REFERENCED_MEDIA_URL.replace(OWNER_ID, DOCUMENT_ID),
    "/m/invalid",
  ];
  const response = await harness.request({
    mediaUrls: [harness.mediaUrls[0], ...invalid],
  });
  assertEquals(harness.calls.length, 1);
  assertEquals(harness.calls[0].paths, [
    `${OWNER_ID}/${DOCUMENT_ID}/referenced.png`,
  ]);
  assertEquals(
    (await response.json()).urls.slice(1),
    invalid.map((mediaUrl) => ({ mediaUrl, signedUrl: null, retry: false })),
  );
});

Deno.test("batch revocation is checked again on every request", async () => {
  const harness = createBatchHarness();
  await harness.request({ mediaUrls: harness.mediaUrls });
  harness.revoke();
  assertEquals(
    (await harness.request({ mediaUrls: harness.mediaUrls })).status,
    404,
  );
  assertEquals(harness.reads, 2);
  assertEquals(harness.calls.length, 2);
});

Deno.test("per-object signing errors do not discard the other bucket", async () => {
  const harness = createBatchHarness();
  harness.failImages();
  const response = await harness.request({ mediaUrls: harness.mediaUrls });
  const { urls } = await response.json();
  assertEquals(urls[0].signedUrl, null);
  assertEquals(urls[0].retry, true);
  assertEquals(typeof urls[1].signedUrl, "string");
});

Deno.test("malformed, ambiguous and oversized batches are rejected before document lookup", async () => {
  for (
    const body of [
      { mediaUrls: [] },
      { mediaUrls: "bad" },
      { mediaUrls: [42] },
      { mediaUrls: Array(51).fill(REFERENCED_MEDIA_URL) },
      { mediaUrls: ["x".repeat(4097)] },
      { mediaUrls: [REFERENCED_MEDIA_URL], mediaUrl: REFERENCED_MEDIA_URL },
    ]
  ) {
    const harness = createBatchHarness();
    assertEquals((await harness.request(body)).status, 400);
    assertEquals(harness.reads, 0);
  }
});

Deno.test("twenty images require one document read and one Storage signing call", async () => {
  const harness = createBatchHarness();
  harness.mediaUrls.splice(
    0,
    harness.mediaUrls.length,
    ...Array.from(
      { length: 20 },
      (_, i) => `/m/document-images/${OWNER_ID}/${DOCUMENT_ID}/${i}.png`,
    ),
  );
  const response = await harness.request({ mediaUrls: harness.mediaUrls });
  assertEquals(response.status, 200);
  assertEquals(harness.reads, 1);
  assertEquals(harness.calls.length, 1);
  assertEquals(harness.calls[0].paths.length, 20);
});
