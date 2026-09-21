import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { fetchSharedMediaUrls } from "@/lib/shared-document";

vi.mock("@/lib/shared-document", () => ({ fetchSharedMediaUrls: vi.fn() }));
const request = (body: unknown) =>
  new Request("https://app.example/s/doc/token/media", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const context = () => ({
  params: Promise.resolve({ id: "doc", token: "token" }),
});
beforeEach(() => vi.mocked(fetchSharedMediaUrls).mockReset());

describe("shared media batch route", () => {
  it("rejects malformed and oversized input before reaching the edge function", async () => {
    for (
      const body of [
        null,
        {},
        { mediaUrls: "bad" },
        { mediaUrls: [] },
        { mediaUrls: [42] },
        { mediaUrls: ["x".repeat(4097)] },
        { mediaUrls: Array(51).fill("/m/a") },
      ]
    ) {
      expect((await POST(request(body), context())).status).toBe(400);
    }
    expect(
      (await POST(
        new Request("https://app.example/media", { method: "POST", body: "{" }),
        context(),
      )).status,
    ).toBe(400);
    expect(fetchSharedMediaUrls).not.toHaveBeenCalled();
  });

  it("returns successful results with no-store headers", async () => {
    const result = {
      urls: [{
        mediaUrl: "/m/a",
        signedUrl: "https://project.supabase.co/signed/a",
      }],
      expiresIn: 300,
    };
    vi.mocked(fetchSharedMediaUrls).mockResolvedValue({ status: "success", data: result });
    const response = await POST(request({ mediaUrls: ["/m/a"] }), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await response.json()).toEqual(result);
    expect(fetchSharedMediaUrls).toHaveBeenCalledWith("doc", "token", ["/m/a"]);
  });

  it("signals old edge deployments with 503 and preserves revoked-share denials", async () => {
    vi.mocked(fetchSharedMediaUrls).mockResolvedValueOnce({ status: "unavailable" })
      .mockResolvedValueOnce({ status: "not_found" });
    const unavailable = await POST(request({ mediaUrls: ["/m/a"] }), context());
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("Cache-Control")).toContain("no-store");
    const revoked = await POST(request({ mediaUrls: ["/m/a"] }), context());
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ urls: [], expiresIn: 0 });
  });
});
