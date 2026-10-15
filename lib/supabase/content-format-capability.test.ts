import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DOCUMENT_CONTENT_FORMATS_CAPABILITY,
  DOCUMENT_CONTENT_FORMATS_HEADER,
} from "@/lib/page-document";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  createBrowserClient: vi.fn(),
  createServerClient: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: mocks.createBrowserClient,
  createServerClient: mocks.createServerClient,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

describe("document content-format capability", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    mocks.createBrowserClient.mockReset().mockReturnValue({ kind: "browser" });
    mocks.createServerClient.mockReset().mockReturnValue({ kind: "server" });
    mocks.cookies.mockReset().mockResolvedValue({
      getAll: vi.fn(() => []),
      set: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("advertises page support on browser PostgREST requests", async () => {
    const { createSupabaseBrowserClient } = await import("@/lib/supabase/client");

    createSupabaseBrowserClient();

    expect(mocks.createBrowserClient).toHaveBeenCalledWith(
      "https://project-ref.supabase.co",
      "anon-key",
      expect.objectContaining({
        global: {
          headers: {
            [DOCUMENT_CONTENT_FORMATS_HEADER]:
              DOCUMENT_CONTENT_FORMATS_CAPABILITY,
          },
        },
      }),
    );
  });

  it("advertises page support on authenticated server requests", async () => {
    const { createSupabaseServerClient } = await import("@/lib/supabase/server");

    await createSupabaseServerClient();

    expect(mocks.createServerClient).toHaveBeenCalledWith(
      "https://project-ref.supabase.co",
      "anon-key",
      expect.objectContaining({
        global: {
          headers: {
            [DOCUMENT_CONTENT_FORMATS_HEADER]:
              DOCUMENT_CONTENT_FORMATS_CAPABILITY,
          },
        },
      }),
    );
  });
});
