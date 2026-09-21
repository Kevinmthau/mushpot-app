// Both Vitest and Deno consume these cases. Keep fixture values independent of
// the parser so a runtime or adapter change cannot silently redefine the rules.
export const MEDIA_FIXTURE_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const MEDIA_FIXTURE_DOCUMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const MEDIA_FIXTURE_SUPABASE_URL = "https://project-ref.supabase.co";
const PATH = `${MEDIA_FIXTURE_OWNER}/${MEDIA_FIXTURE_DOCUMENT}`;
const STABLE = `/m/document-images/${PATH}`;
const PUBLIC =
  `${MEDIA_FIXTURE_SUPABASE_URL}/storage/v1/object/public/document-images/${PATH}`;

function media(
  file: string,
  bucket: "document-images" | "document-videos" = "document-images",
  ownerId = MEDIA_FIXTURE_OWNER,
  documentId = MEDIA_FIXTURE_DOCUMENT,
) {
  return {
    status: "media" as const,
    media: {
      bucket,
      ownerId,
      documentId,
      storagePath: `${ownerId}/${documentId}/${file}`,
    },
  };
}
const unrelated = { status: "unrelated" as const };
const invalidUrl = { status: "invalid" as const, reason: "url" as const };
const invalidPath = { status: "invalid" as const, reason: "path" as const };

export const DOCUMENT_MEDIA_PARSE_FIXTURES = [
  {
    name: "stable URL without configuration",
    url: `${STABLE}/photo.png`,
    expected: media("photo.png"),
  },
  {
    name: "stable URL with malformed configuration",
    url: `${STABLE}/photo.png`,
    supabaseUrl: "bad",
    expected: media("photo.png"),
  },
  {
    name: "encoded punctuation and spaces",
    url: `${STABLE}/it%27s%20%28mine%29.png`,
    expected: media("it's (mine).png"),
  },
  {
    name: "unicode filename",
    url: `${STABLE}/%E8%8A%B1.png`,
    expected: media("花.png"),
  },
  {
    name: "nested filename",
    url: `${STABLE}/nested/photo.png`,
    expected: media("nested/photo.png"),
  },
  {
    name: "decode percent escapes exactly once",
    url: `${STABLE}/literal%252F.png`,
    expected: media("literal%2F.png"),
  },
  {
    name: "ignore URL query and fragment when identifying an object",
    url: `${STABLE}/photo.png?download=1#preview`,
    expected: media("photo.png"),
  },
  {
    name: "video bucket",
    url: `/m/document-videos/${PATH}/clip.mp4#t=0.1`,
    expected: media("clip.mp4", "document-videos"),
  },
  {
    name: "uppercase identifiers preserve storage object case",
    url: `/m/document-images/${PATH.toUpperCase()}/photo.png`,
    expected: media(
      "photo.png",
      "document-images",
      MEDIA_FIXTURE_OWNER.toUpperCase(),
      MEDIA_FIXTURE_DOCUMENT.toUpperCase(),
    ),
  },
  {
    name: "legacy public URL",
    url: `${PUBLIC}/photo.png`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: media("photo.png"),
  },
  {
    name: "legacy transformed image",
    url:
      `${MEDIA_FIXTURE_SUPABASE_URL}/storage/v1/render/image/public/document-images/${PATH}/photo.png?width=500`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: media("photo.png"),
  },
  {
    name: "direct storage host",
    url:
      `https://project-ref.storage.supabase.co/storage/v1/object/public/document-images/${PATH}/photo.png`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: media("photo.png"),
  },
  {
    name: "custom Supabase origin",
    url:
      `http://localhost:54321/storage/v1/object/public/document-images/${PATH}/photo.png`,
    supabaseUrl: "http://localhost:54321",
    expected: media("photo.png"),
  },
  {
    name: "legacy URL requires configuration",
    url: `${PUBLIC}/photo.png`,
    expected: unrelated,
  },
  {
    name: "malformed configuration cannot claim a legacy URL",
    url: `${PUBLIC}/photo.png`,
    supabaseUrl: "bad",
    expected: unrelated,
  },
  {
    name: "foreign project",
    url:
      `https://foreign.supabase.co/storage/v1/object/public/document-images/${PATH}/photo.png`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: unrelated,
  },
  {
    name: "lookalike origin",
    url:
      `https://project-ref.supabase.co.evil.example/storage/v1/object/public/document-images/${PATH}/photo.png`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: unrelated,
  },
  {
    name: "direct host requires HTTPS",
    url:
      `http://project-ref.storage.supabase.co/storage/v1/object/public/document-images/${PATH}/photo.png`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: unrelated,
  },
  {
    name: "direct host rejects extra port",
    url:
      `https://project-ref.storage.supabase.co:8443/storage/v1/object/public/document-images/${PATH}/photo.png`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: unrelated,
  },
  {
    name: "project origin rejects extra port",
    url:
      `https://project-ref.supabase.co:8443/storage/v1/object/public/document-images/${PATH}/photo.png`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: unrelated,
  },
  {
    name: "signed storage URLs are not legacy public references",
    url:
      `${MEDIA_FIXTURE_SUPABASE_URL}/storage/v1/object/sign/document-images/${PATH}/photo.png?token=secret`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: unrelated,
  },
  {
    name: "unrelated project route",
    url: `${MEDIA_FIXTURE_SUPABASE_URL}/other/photo.png`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: unrelated,
  },
  {
    name: "absolute app media URL is not a stable relative reference",
    url: `https://app.example${STABLE}/photo.png`,
    supabaseUrl: MEDIA_FIXTURE_SUPABASE_URL,
    expected: unrelated,
  },
  {
    name: "unknown bucket",
    url: `/m/avatars/${PATH}/photo.png`,
    expected: invalidUrl,
  },
  { name: "empty filename", url: `${STABLE}/`, expected: invalidUrl },
  { name: "missing filename", url: STABLE, expected: invalidUrl },
  {
    name: "malformed encoding",
    url: `${STABLE}/photo%GG.png`,
    expected: invalidUrl,
  },
  {
    name: "encoded separator",
    url: `${STABLE}/a%2Fb.png`,
    expected: invalidUrl,
  },
  {
    name: "encoded backslash",
    url: `${STABLE}/a%5Cb.png`,
    expected: invalidUrl,
  },
  { name: "encoded NUL", url: `${STABLE}/a%00b.png`, expected: invalidUrl },
  {
    name: "empty nested segment",
    url: `${STABLE}//photo.png`,
    expected: invalidUrl,
  },
  {
    name: "encoded traversal changes document scope",
    url: `${STABLE}/%2E%2E/photo.png`,
    expected: invalidUrl,
  },
  {
    name: "invalid owner UUID",
    url: `/m/document-images/not-an-owner/${MEDIA_FIXTURE_DOCUMENT}/photo.png`,
    expected: invalidPath,
  },
  {
    name: "invalid document UUID",
    url: `/m/document-images/${MEDIA_FIXTURE_OWNER}/not-a-document/photo.png`,
    expected: invalidPath,
  },
  {
    name: "invalid UUID variant",
    url:
      `/m/document-images/aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa/${MEDIA_FIXTURE_DOCUMENT}/photo.png`,
    expected: invalidPath,
  },
];

export const DOCUMENT_MEDIA_ENCODING_FIXTURES = [
  { path: `${PATH}/photo.png`, encoded: `${PATH}/photo.png` },
  {
    path: `${PATH}/it's (mine)!.png`,
    encoded: `${PATH}/it%27s%20%28mine%29%21.png`,
  },
  { path: `${PATH}/花.png`, encoded: `${PATH}/%E8%8A%B1.png` },
  { path: `${PATH}/literal%2F.png`, encoded: `${PATH}/literal%252F.png` },
  { path: `${PATH}/nested/photo.png`, encoded: `${PATH}/nested/photo.png` },
];

export const DOCUMENT_MEDIA_INVALID_PATH_FIXTURES = [
  "",
  `${PATH}/`,
  `${PATH}/../secret.png`,
  `${PATH}/./photo.png`,
  `${PATH}/a\\b.png`,
  `${PATH}/a\0b.png`,
  `${PATH}//photo.png`,
];
