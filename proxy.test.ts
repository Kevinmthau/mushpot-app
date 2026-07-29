import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PRIVATE_NEXT_PATH_HEADER } from "@/lib/app-url";
import { proxy } from "@/proxy";

type ProxyCookieMethods = {
  setAll: (
    cookies: Array<{
      name: string;
      value: string;
      options: Record<string, unknown>;
    }>,
    headers: Record<string, string>,
  ) => void;
};

const mocks = vi.hoisted(() => {
  const getClaims = vi.fn();

  return {
    createServerClient: vi.fn<
      (url: string, key: string, options: unknown) => {
        auth: { getClaims: typeof getClaims };
      }
    >(),
    getClaims,
  };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: mocks.createServerClient,
}));

function buildRequest(url: string, cookie?: string) {
  return new NextRequest(url, {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("proxy", () => {
  let cookieMethods: ProxyCookieMethods;

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    mocks.getClaims.mockReset();
    mocks.createServerClient.mockClear();
    mocks.createServerClient.mockImplementation(
      (_url: string, _key: string, options: unknown) => {
        cookieMethods = (options as { cookies: ProxyCookieMethods }).cookies;
        return { auth: { getClaims: mocks.getClaims } };
      },
    );
  });

  it("redirects private requests when verified claims are unavailable", async () => {
    mocks.getClaims.mockResolvedValue({ data: null, error: new Error("invalid") });

    const response = await proxy(
      buildRequest("https://mushpot.app/doc/abc?view=edit"),
    );

    expect(response.headers.get("location")).toBe(
      "https://mushpot.app/auth?next=%2Fdoc%2Fabc%3Fview%3Dedit",
    );
  });

  it("preserves cookie removal options when an invalid session redirects", async () => {
    mocks.getClaims.mockImplementation(async () => {
      cookieMethods.setAll(
        [
          {
            name: "sb-test-auth-token",
            value: "",
            options: { maxAge: 0, path: "/", sameSite: "lax" },
          },
        ],
        {
          "Cache-Control":
            "private, no-cache, no-store, must-revalidate, max-age=0",
        },
      );

      return { data: null, error: new Error("invalid") };
    });

    const response = await proxy(
      buildRequest(
        "https://mushpot.app/doc/abc",
        "sb-test-auth-token=expired",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://mushpot.app/auth?next=%2Fdoc%2Fabc",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "sb-test-auth-token=; Path=/; Max-Age=0; SameSite=lax",
    );
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  });

  it("passes the full private next path after verifying the JWT", async () => {
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: "user-1" } },
      error: null,
    });

    const response = await proxy(
      buildRequest(
        "https://mushpot.app/doc/abc?view=edit",
        "sb-test-auth-token=valid",
      ),
    );

    expect(
      response.headers.get(`x-middleware-request-${PRIVATE_NEXT_PATH_HEADER}`),
    ).toBe("/doc/abc?view=edit");
    expect(mocks.getClaims).toHaveBeenCalledOnce();
  });

  it("forwards refreshed cookies and Supabase cache-control headers", async () => {
    mocks.getClaims.mockImplementation(async () => {
      cookieMethods.setAll(
        [
          {
            name: "sb-test-auth-token",
            value: "refreshed",
            options: { path: "/", sameSite: "lax" },
          },
        ],
        {
          "Cache-Control":
            "private, no-cache, no-store, must-revalidate, max-age=0",
          Expires: "0",
          Pragma: "no-cache",
        },
      );

      return {
        data: { claims: { sub: "user-1" } },
        error: null,
      };
    });

    const response = await proxy(
      buildRequest("https://mushpot.app/doc/abc?view=edit"),
    );

    expect(response.cookies.get("sb-test-auth-token")?.value).toBe("refreshed");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-middleware-request-cookie")).toContain(
      "sb-test-auth-token=refreshed",
    );
    expect(
      response.headers.get(`x-middleware-request-${PRIVATE_NEXT_PATH_HEADER}`),
    ).toBe("/doc/abc?view=edit");
  });
});
