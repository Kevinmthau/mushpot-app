import { afterEach, describe, expect, it } from "vitest";

import {
  buildAuthRedirectPath,
  getConfiguredAppOrigin,
  getRequestOriginFromHeaders,
  normalizeInternalPath,
  normalizeInternalPathFormValue,
  resolveAppOriginFromHeaders,
  stripTrailingSlashes,
} from "@/lib/app-url";

function headers(values: Record<string, string>) {
  return {
    get(name: string) {
      return values[name.toLowerCase()] ?? null;
    },
  };
}

describe("stripTrailingSlashes", () => {
  it("removes one or more trailing slashes", () => {
    expect(stripTrailingSlashes("https://example.com///")).toBe(
      "https://example.com",
    );
    expect(stripTrailingSlashes("https://example.com")).toBe(
      "https://example.com",
    );
  });
});

describe("normalizeInternalPath", () => {
  it("returns '/' for empty, missing, or non-rooted paths", () => {
    expect(normalizeInternalPath(null)).toBe("/");
    expect(normalizeInternalPath(undefined)).toBe("/");
    expect(normalizeInternalPath("")).toBe("/");
    expect(normalizeInternalPath("dashboard")).toBe("/");
  });

  it("blocks protocol-relative and absolute URLs (open redirect guard)", () => {
    expect(normalizeInternalPath("//evil.com")).toBe("/");
    expect(normalizeInternalPath("https://evil.com")).toBe("/");
    expect(normalizeInternalPath("\\\\evil.com")).toBe("/");
  });

  it("preserves the path, query, and hash of valid internal paths", () => {
    expect(normalizeInternalPath("/doc/123")).toBe("/doc/123");
    expect(normalizeInternalPath("/doc/123?tab=share#top")).toBe(
      "/doc/123?tab=share#top",
    );
  });
});

describe("normalizeInternalPathFormValue", () => {
  it("normalizes string form values", () => {
    expect(normalizeInternalPathFormValue("/doc/1")).toBe("/doc/1");
    expect(normalizeInternalPathFormValue("//evil.com")).toBe("/");
  });

  it("returns '/' for non-string (File) form values", () => {
    expect(normalizeInternalPathFormValue(new File([], "f.txt"))).toBe("/");
    expect(normalizeInternalPathFormValue(null)).toBe("/");
  });
});

describe("getRequestOriginFromHeaders", () => {
  it("returns null when no host header is present", () => {
    expect(getRequestOriginFromHeaders(headers({}))).toBeNull();
  });

  it("defaults to https for non-localhost hosts", () => {
    expect(getRequestOriginFromHeaders(headers({ host: "example.com" }))).toBe(
      "https://example.com",
    );
  });

  it("defaults to http for localhost hosts", () => {
    expect(
      getRequestOriginFromHeaders(headers({ host: "localhost:3000" })),
    ).toBe("http://localhost:3000");
  });

  it("honors x-forwarded-* headers and takes the first comma-listed value", () => {
    expect(
      getRequestOriginFromHeaders(
        headers({
          "x-forwarded-host": "app.example.com, internal.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://app.example.com");
  });
});

describe("resolveAppOriginFromHeaders", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it("prefers the configured origin when the request comes from localhost", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://mushpot.app/";
    expect(getConfiguredAppOrigin()).toBe("https://mushpot.app");
    expect(
      resolveAppOriginFromHeaders(headers({ host: "localhost:3000" })),
    ).toBe("https://mushpot.app");
  });

  it("uses the request origin for non-localhost requests", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://mushpot.app";
    expect(resolveAppOriginFromHeaders(headers({ host: "real.com" }))).toBe(
      "https://real.com",
    );
  });

  it("falls back to the configured origin when there is no request origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://mushpot.app";
    expect(resolveAppOriginFromHeaders(headers({}))).toBe(
      "https://mushpot.app",
    );
  });

  it("keeps the localhost origin when no app origin is configured", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      resolveAppOriginFromHeaders(headers({ host: "localhost:3000" })),
    ).toBe("http://localhost:3000");
  });
});

describe("buildAuthRedirectPath", () => {
  it("encodes a normalized next path", () => {
    expect(buildAuthRedirectPath("/doc/1")).toBe("/auth?next=%2Fdoc%2F1");
  });

  it("normalizes unsafe next paths before encoding", () => {
    expect(buildAuthRedirectPath("//evil.com", { sent: "1" })).toBe(
      "/auth?next=%2F&sent=1",
    );
  });

  it("includes error and sent params when provided", () => {
    expect(buildAuthRedirectPath("/doc/1", { error: "expired" })).toBe(
      "/auth?next=%2Fdoc%2F1&error=expired",
    );
  });
});
