import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { PRIVATE_NEXT_PATH_HEADER } from "@/lib/app-url";
import { proxy } from "@/proxy";

function buildRequest(url: string, cookie?: string) {
  return new NextRequest(url, {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("proxy", () => {
  it("redirects unauthenticated private requests with the full next path", () => {
    const response = proxy(buildRequest("https://mushpot.app/doc/abc?view=edit"));

    expect(response.headers.get("location")).toBe(
      "https://mushpot.app/auth?next=%2Fdoc%2Fabc%3Fview%3Dedit",
    );
  });

  it("passes the full private next path to layouts when an auth cookie exists", () => {
    const response = proxy(
      buildRequest(
        "https://mushpot.app/doc/abc?view=edit",
        "sb-test-auth-token=stale",
      ),
    );

    expect(
      response.headers.get(`x-middleware-request-${PRIVATE_NEXT_PATH_HEADER}`),
    ).toBe("/doc/abc?view=edit");
  });
});
