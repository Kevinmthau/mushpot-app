import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PRIVATE_NEXT_PATH_HEADER } from "@/lib/app-url";
import { config, proxy } from "@/proxy";

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
  const getSession = vi.fn();

  return {
    createServerClient: vi.fn<
      (url: string, key: string, options: unknown) => {
        auth: {
          getClaims: typeof getClaims;
          getSession: typeof getSession;
        };
      }
    >(),
    getClaims,
    getSession,
  };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: mocks.createServerClient,
}));

function buildRequest(
  url: string,
  options: { cookie?: string; headers?: Record<string, string> } = {},
) {
  const headers = new Headers(options.headers);
  if (options.cookie) {
    headers.set("cookie", options.cookie);
  }

  return new NextRequest(url, { headers });
}

describe("proxy session refresh", () => {
  let cookieMethods: ProxyCookieMethods;

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    mocks.getClaims.mockReset();
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: "verified-user" } },
      error: null,
    });
    mocks.getSession.mockReset();
    mocks.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    mocks.createServerClient.mockClear();
    mocks.createServerClient.mockImplementation(
      (_url: string, _key: string, options: unknown) => {
        cookieMethods = (options as { cookies: ProxyCookieMethods }).cookies;
        return {
          auth: {
            getClaims: mocks.getClaims,
            getSession: mocks.getSession,
          },
        };
      },
    );
  });

  it("verifies once and passes the actual private next path to the layout", async () => {
    const response = await proxy(
      buildRequest("https://mushpot.app/doc/abc?view=edit", {
        cookie: "sb-test-auth-token=valid",
      }),
    );

    expect(mocks.getClaims).toHaveBeenCalledOnce();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(
      response.headers.get(`x-middleware-request-${PRIVATE_NEXT_PATH_HEADER}`),
    ).toBe("/doc/abc?view=edit");
  });

  it("redirects private requests when verified claims are missing", async () => {
    mocks.getClaims.mockResolvedValue({ data: null, error: null });

    const response = await proxy(
      buildRequest("https://mushpot.app/doc/abc?view=edit"),
    );

    expect(response.headers.get("location")).toBe(
      "https://mushpot.app/auth?next=%2Fdoc%2Fabc%3Fview%3Dedit",
    );
  });

  it("fails closed when claims verification reports an error", async () => {
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: "untrusted-user" } },
      error: new Error("verification failed"),
    });

    const response = await proxy(buildRequest("https://mushpot.app/doc/abc"));

    expect(response.headers.get("location")).toBe(
      "https://mushpot.app/auth?next=%2Fdoc%2Fabc",
    );
  });

  it("overwrites a client-supplied private next path", async () => {
    const response = await proxy(
      buildRequest("https://mushpot.app/doc/real?view=edit", {
        headers: {
          [PRIVATE_NEXT_PATH_HEADER]: "/doc/spoofed",
        },
      }),
    );

    expect(
      response.headers.get(`x-middleware-request-${PRIVATE_NEXT_PATH_HEADER}`),
    ).toBe("/doc/real?view=edit");
  });

  it("preserves cookie removal options when claims verification rejects a session", async () => {
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
      buildRequest("https://mushpot.app/doc/abc", {
        cookie: "sb-test-auth-token=expired",
      }),
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
        data: { claims: { sub: "verified-user" } },
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
  });

  it("refreshes the exact auth page without forwarding private context", async () => {
    mocks.getSession.mockImplementation(async () => {
      cookieMethods.setAll(
        [
          {
            name: "sb-test-auth-token",
            value: "refreshed-on-auth",
            options: { path: "/", sameSite: "lax" },
          },
        ],
        {
          "Cache-Control":
            "private, no-cache, no-store, must-revalidate, max-age=0",
        },
      );

      return { data: { session: null }, error: null };
    });

    const response = await proxy(buildRequest("https://mushpot.app/auth"));

    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.getClaims).not.toHaveBeenCalled();
    expect(response.cookies.get("sb-test-auth-token")?.value).toBe(
      "refreshed-on-auth",
    );
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    expect(
      response.headers.get(`x-middleware-request-${PRIVATE_NEXT_PATH_HEADER}`),
    ).toBeNull();
  });

  it("short-circuits routes that own no session refresh or protection", async () => {
    const response = await proxy(
      buildRequest("https://mushpot.app/s/document/share-token"),
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.getClaims).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});

describe("proxy matcher", () => {
  it.each([
    "/",
    "/doc",
    "/doc/",
    "/doc/document-a",
    "/doc/document-a?view=edit",
    "/auth",
  ])(
    "runs for %s",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    },
  );

  it.each([
    "/auth/confirm",
    "/auth/verify",
    "/auth/callback",
    "/m/document-images/file.png",
    "/s/document/share-token",
    "/sw.js",
    "/manifest.webmanifest",
    "/offline.html",
    "/missing",
  ])("skips %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });
});
