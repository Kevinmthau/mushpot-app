import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRIVATE_NEXT_PATH_HEADER } from "@/lib/app-url";

import PrivateLayout, { dynamic } from "./layout";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getClaims: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

function requestHeaders(values: Record<string, string> = {}) {
  return new Headers(values);
}

beforeEach(() => {
  mocks.headers.mockResolvedValue(requestHeaders());
  mocks.getClaims.mockReset();
  mocks.createSupabaseServerClient.mockReset();
  mocks.createSupabaseServerClient.mockResolvedValue({
    auth: { getClaims: mocks.getClaims },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("private layout authorization", () => {
  it("uses one verified subject for the private session provider", async () => {
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: "verified-user" } },
      error: null,
    });

    const result = await PrivateLayout({ children: "private content" });

    expect(mocks.getClaims).toHaveBeenCalledOnce();
    expect((result.props as { initialUserId: string }).initialUserId).toBe(
      "verified-user",
    );
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("fails closed and preserves the proxy-derived next path without claims", async () => {
    mocks.headers.mockResolvedValue(
      requestHeaders({
        [PRIVATE_NEXT_PATH_HEADER]: "/doc/document-a?view=edit",
      }),
    );
    mocks.getClaims.mockResolvedValue({ data: null, error: null });

    await expect(
      PrivateLayout({ children: "private content" }),
    ).rejects.toThrow(
      "redirect:/auth?next=%2Fdoc%2Fdocument-a%3Fview%3Dedit",
    );
  });

  it("fails closed when verification reports an error alongside claims", async () => {
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: "untrusted-user" } },
      error: new Error("verification failed"),
    });

    await expect(
      PrivateLayout({ children: "private content" }),
    ).rejects.toThrow("redirect:/auth?next=%2F");
  });

  it("remains dynamically rendered so authenticated HTML is never reused", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
