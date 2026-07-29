import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

async function getConfiguredHeaders() {
  const configuredHeaders = await nextConfig.headers?.();

  if (!configuredHeaders) {
    throw new Error("Expected Next.js response headers to be configured.");
  }

  return configuredHeaders;
}

describe("security response headers", () => {
  it("applies browser hardening to every route", async () => {
    const configuredHeaders = await getConfiguredHeaders();
    const globalHeaders = configuredHeaders.find(
      ({ source }) => source === "/:path*",
    )?.headers;

    expect(globalHeaders).toEqual(
      expect.arrayContaining([
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
      ]),
    );

    const contentSecurityPolicy = globalHeaders?.find(
      ({ key }) => key === "Content-Security-Policy",
    )?.value;

    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy).toContain(
      "frame-src https://challenges.cloudflare.com",
    );
    expect(contentSecurityPolicy).toContain("img-src 'self' data: blob: https:");
    expect(contentSecurityPolicy).toContain("media-src 'self' blob: https:");
    expect(contentSecurityPolicy).toContain("connect-src 'self' https: wss:");
  });

  it("prevents shared-document responses from being cached or indexed", async () => {
    const configuredHeaders = await getConfiguredHeaders();
    const sharedHeaders = configuredHeaders.find(
      ({ source }) => source === "/s/:path*",
    )?.headers;

    expect(sharedHeaders).toEqual(
      expect.arrayContaining([
        {
          key: "Cache-Control",
          value: "private, no-store, max-age=0, must-revalidate",
        },
        { key: "CDN-Cache-Control", value: "no-store" },
        { key: "Netlify-CDN-Cache-Control", value: "no-store" },
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      ]),
    );
  });
});
