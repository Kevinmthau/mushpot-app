import { describe, expect, it } from "vitest";

import {
  getCaptchaConfiguration,
  normalizeCaptchaToken,
} from "@/lib/auth-captcha";

describe("getCaptchaConfiguration", () => {
  it("requires a configured Turnstile challenge", () => {
    expect(
      getCaptchaConfiguration({
        NODE_ENV: "development",
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: " site-key ",
      }),
    ).toEqual({
      siteKey: "site-key",
      required: true,
      configurationError: false,
    });
  });

  it("allows local development without Turnstile", () => {
    expect(getCaptchaConfiguration({ NODE_ENV: "development" })).toEqual({
      siteKey: null,
      required: false,
      configurationError: false,
    });
  });

  it("fails closed in production without a site key", () => {
    expect(getCaptchaConfiguration({ NODE_ENV: "production" })).toEqual({
      siteKey: null,
      required: false,
      configurationError: true,
    });
  });
});

describe("normalizeCaptchaToken", () => {
  it("normalizes non-empty string tokens", () => {
    expect(normalizeCaptchaToken(" token ")).toBe("token");
  });

  it("rejects missing, empty, and non-string tokens", () => {
    expect(normalizeCaptchaToken(null)).toBeNull();
    expect(normalizeCaptchaToken("   ")).toBeNull();
    expect(normalizeCaptchaToken(new File([], "token.txt"))).toBeNull();
  });
});
