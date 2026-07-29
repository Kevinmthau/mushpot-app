import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  flushDirtyDocuments,
  normalizeDocumentTitle,
} from "@/lib/document-sync";

const mocks = vi.hoisted(() => ({
  getDocumentCacheWriteToken: vi.fn(),
  getDirtyDocuments: vi.fn(),
  putCachedDocument: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  firstEq: vi.fn(),
  secondEq: vi.fn(),
  select: vi.fn(),
  single: vi.fn(),
}));

vi.mock("@/lib/doc-cache", () => ({
  getDocumentCacheWriteToken: mocks.getDocumentCacheWriteToken,
  getDirtyDocuments: mocks.getDirtyDocuments,
  putCachedDocument: mocks.putCachedDocument,
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: vi.fn(async () => ({
    from: mocks.from,
  })),
}));

describe("normalizeDocumentTitle", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeDocumentTitle("  My Notes  ")).toBe("My Notes");
  });

  it("falls back to 'Untitled' for empty or whitespace-only titles", () => {
    expect(normalizeDocumentTitle("")).toBe("Untitled");
    expect(normalizeDocumentTitle("   \t ")).toBe("Untitled");
  });

  it("leaves an already-clean title unchanged", () => {
    expect(normalizeDocumentTitle("Roadmap")).toBe("Roadmap");
  });
});

describe("flushDirtyDocuments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDocumentCacheWriteToken.mockReturnValue({
      generation: 4,
      owner: "active-owner",
    });
    mocks.from.mockReturnValue({ update: mocks.update });
    mocks.update.mockReturnValue({ eq: mocks.firstEq });
    mocks.firstEq.mockReturnValue({ eq: mocks.secondEq });
    mocks.secondEq.mockReturnValue({ select: mocks.select });
    mocks.select.mockReturnValue({ single: mocks.single });
    mocks.single.mockResolvedValue({
      data: { updated_at: "2026-07-17T12:00:00.000Z" },
      error: null,
    });
  });

  it("queries and retries only dirty documents owned by the active user", async () => {
    mocks.getDirtyDocuments.mockResolvedValue([
      {
        id: "active-document",
        owner: "active-owner",
        title: "Active",
        content: "Keep",
        updated_at: "2026-07-17T11:00:00.000Z",
        share_enabled: false,
        share_token: null,
        _dirty: true,
      },
      {
        id: "other-document",
        owner: "other-owner",
        title: "Other",
        content: "Do not retry",
        updated_at: "2026-07-17T11:00:00.000Z",
        share_enabled: true,
        share_token: "secret-token",
        _dirty: true,
      },
    ]);

    await flushDirtyDocuments("active-owner");

    expect(mocks.getDirtyDocuments).toHaveBeenCalledWith("active-owner");
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.firstEq).toHaveBeenCalledWith("id", "active-document");
    expect(mocks.secondEq).toHaveBeenCalledWith("owner", "active-owner");
    expect(mocks.putCachedDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "active-document",
        owner: "active-owner",
        _dirty: false,
      }),
      { generation: 4, owner: "active-owner" },
    );
  });

  it("does not start a flush after the owner's cache is deactivated", async () => {
    mocks.getDocumentCacheWriteToken.mockReturnValue(null);

    await flushDirtyDocuments("active-owner");

    expect(mocks.getDirtyDocuments).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
