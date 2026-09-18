import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { getLinkPreview, LinkPreviewError } from "@/lib/link-preview-server";

vi.mock("@/lib/link-preview-server", () => ({
  getLinkPreview: vi.fn(),
  LinkPreviewError: class extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
    }
  },
}));

beforeEach(() => vi.resetAllMocks());

describe("GET /api/link-preview", () => {
  it("returns public metadata with private browser caching", async () => {
    const metadata = { url: "https://example.com/", title: "Example" };
    vi.mocked(getLinkPreview).mockResolvedValue(metadata);
    const response = await GET(new Request("https://mushpot.test/api/link-preview?url=https%3A%2F%2Fexample.com%2F"));
    expect(getLinkPreview).toHaveBeenCalledWith("https://example.com/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(metadata);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=300");
  });

  it("passes a missing URL to validation", async () => {
    vi.mocked(getLinkPreview).mockRejectedValue(new LinkPreviewError(400, "Invalid URL"));
    const response = await GET(new Request("https://mushpot.test/api/link-preview"));
    expect(getLinkPreview).toHaveBeenCalledWith("");
    expect(response.status).toBe(400);
  });

  it("returns a retry hint when the server request budget is exhausted", async () => {
    vi.mocked(getLinkPreview).mockRejectedValue(new LinkPreviewError(429, "Busy"));
    const response = await GET(new Request("https://mushpot.test/api/link-preview?url=https://example.com"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not expose upstream connection details in unexpected errors", async () => {
    vi.mocked(getLinkPreview).mockRejectedValue(new Error("Connection failed at secret-host:443"));
    const response = await GET(new Request("https://mushpot.test/api/link-preview?url=https://example.com"));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Link preview unavailable." });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
