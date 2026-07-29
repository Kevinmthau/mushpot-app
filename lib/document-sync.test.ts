import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  flushDirtyDocuments,
  normalizeDocumentTitle,
  persistDocumentSnapshot,
} from "@/lib/document-sync";

const mocks = vi.hoisted(() => ({
  getDocumentCacheWriteToken: vi.fn(),
  getDirtyDocuments: vi.fn(),
  putCachedDocument: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  updateIdEq: vi.fn(),
  updateOwnerEq: vi.fn(),
  updateVersionEq: vi.fn(),
  updateSelect: vi.fn(),
  updateMaybeSingle: vi.fn(),
  readSelect: vi.fn(),
  readIdEq: vi.fn(),
  readOwnerEq: vi.fn(),
  readMaybeSingle: vi.fn(),
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
    vi.resetAllMocks();
    mocks.getDocumentCacheWriteToken.mockReturnValue({
      generation: 4,
      owner: "active-owner",
    });
    mocks.putCachedDocument.mockResolvedValue(true);
    mocks.from.mockReturnValue({
      select: mocks.readSelect,
      update: mocks.update,
    });
    mocks.update.mockReturnValue({ eq: mocks.updateIdEq });
    mocks.updateIdEq.mockReturnValue({ eq: mocks.updateOwnerEq });
    mocks.updateOwnerEq.mockReturnValue({ eq: mocks.updateVersionEq });
    mocks.updateVersionEq.mockReturnValue({ select: mocks.updateSelect });
    mocks.updateSelect.mockReturnValue({
      maybeSingle: mocks.updateMaybeSingle,
    });
    mocks.readSelect.mockReturnValue({ eq: mocks.readIdEq });
    mocks.readIdEq.mockReturnValue({ eq: mocks.readOwnerEq });
    mocks.readOwnerEq.mockReturnValue({
      maybeSingle: mocks.readMaybeSingle,
    });
    mocks.updateMaybeSingle.mockResolvedValue({
      data: {
        content: "Keep",
        share_enabled: false,
        share_token: null,
        title: "Active",
        updated_at: "2026-07-17T12:00:00.000Z",
      },
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

    const result = await flushDirtyDocuments("active-owner");

    expect(mocks.getDirtyDocuments).toHaveBeenCalledWith("active-owner", {
      generation: 4,
      owner: "active-owner",
    });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.updateIdEq).toHaveBeenCalledWith("id", "active-document");
    expect(mocks.updateOwnerEq).toHaveBeenCalledWith("owner", "active-owner");
    expect(mocks.updateVersionEq).toHaveBeenCalledWith(
      "updated_at",
      "2026-07-17T11:00:00.000Z",
    );
    expect(mocks.putCachedDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "active-document",
        owner: "active-owner",
        _dirty: false,
      }),
      { generation: 4, owner: "active-owner" },
    );
    expect(result).toEqual({
      attempted: 1,
      remaining: 0,
      status: "complete",
      succeeded: 1,
    });
  });

  it("reports unavailable rather than no drafts after cache deactivation", async () => {
    mocks.getDocumentCacheWriteToken.mockReturnValue(null);

    const result = await flushDirtyDocuments("active-owner");

    expect(mocks.getDirtyDocuments).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      attempted: 0,
      remaining: null,
      status: "unavailable",
      succeeded: 0,
    });
  });

  it("reports unavailable when IndexedDB cannot inspect dirty drafts", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.getDirtyDocuments.mockRejectedValue(
      new Error("IndexedDB upgrade blocked"),
    );

    const result = await flushDirtyDocuments("active-owner");

    expect(mocks.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      attempted: 0,
      remaining: null,
      status: "unavailable",
      succeeded: 0,
    });
    consoleError.mockRestore();
  });

  it("returns attempted, successful, and remaining draft counts", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.getDirtyDocuments.mockResolvedValue([
      {
        id: "saved-document",
        owner: "active-owner",
        title: "Saved",
        content: "Saved content",
        updated_at: "2026-07-17T11:00:00.000Z",
        share_enabled: false,
        share_token: null,
        _dirty: true,
      },
      {
        id: "failed-document",
        owner: "active-owner",
        title: "Failed",
        content: "Unsaved content",
        updated_at: "2026-07-17T11:00:00.000Z",
        share_enabled: false,
        share_token: null,
        _dirty: true,
      },
    ]);
    mocks.from
      .mockReturnValueOnce({ update: mocks.update })
      .mockImplementationOnce(() => {
        throw new Error("Browser client unavailable");
      });

    const result = await flushDirtyDocuments("active-owner");

    expect(result).toEqual({
      attempted: 2,
      remaining: 1,
      status: "complete",
      succeeded: 1,
    });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("keeps a draft in the remaining count when a newer cache write wins", async () => {
    mocks.getDirtyDocuments.mockResolvedValue([
      {
        id: "active-document",
        owner: "active-owner",
        title: "Active",
        content: "Snapshot being flushed",
        updated_at: "2026-07-17T11:00:00.000Z",
        share_enabled: false,
        share_token: null,
        _dirty: true,
        _localUpdatedAt: 100,
      },
    ]);
    mocks.putCachedDocument.mockResolvedValue(false);

    const result = await flushDirtyDocuments("active-owner");

    expect(result).toEqual({
      attempted: 1,
      remaining: 1,
      status: "complete",
      succeeded: 0,
    });
  });

  it("does not report persistence success until the clean cache write finishes", async () => {
    let resolveCacheWrite: ((value: boolean) => void) | undefined;
    mocks.putCachedDocument.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveCacheWrite = resolve;
      }),
    );
    let didResolve = false;

    const persistence = persistDocumentSnapshot({
      id: "active-document",
      owner: "active-owner",
      title: "Active",
      content: "Keep",
      share_enabled: false,
      share_token: null,
      updated_at: "2026-07-17T11:00:00.000Z",
    }).then((result) => {
      didResolve = true;
      return result;
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(didResolve).toBe(false);

    resolveCacheWrite?.(true);

    await expect(persistence).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        updatedAt: "2026-07-17T12:00:00.000Z",
      }),
    );
  });

  it("recovers idempotently when the update committed but its response was lost", async () => {
    const responseError = new Error("Connection closed after commit");
    mocks.updateMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: responseError,
    });
    mocks.readMaybeSingle.mockResolvedValueOnce({
      data: {
        content: "Keep",
        share_enabled: true,
        share_token: "server-share-token",
        title: "Active",
        updated_at: "2026-07-17T12:00:00.000Z",
      },
      error: null,
    });

    const result = await persistDocumentSnapshot({
      id: "active-document",
      owner: "active-owner",
      title: "Active",
      content: "Keep",
      share_enabled: false,
      share_token: null,
      updated_at: "2026-07-17T11:00:00.000Z",
    });

    expect(mocks.updateVersionEq).toHaveBeenCalledWith(
      "updated_at",
      "2026-07-17T11:00:00.000Z",
    );
    expect(mocks.readIdEq).toHaveBeenCalledWith("id", "active-document");
    expect(result).toEqual({
      cacheUpdated: true,
      conflict: false,
      ok: true,
      persistedTitle: "Active",
      updatedAt: "2026-07-17T12:00:00.000Z",
    });
    expect(mocks.putCachedDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        _dirty: false,
        share_enabled: true,
        share_token: "server-share-token",
      }),
      expect.anything(),
    );
  });

  it("retains the dirty cache entry on a true concurrent-write conflict", async () => {
    mocks.updateMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    mocks.readMaybeSingle.mockResolvedValueOnce({
      data: {
        content: "Newer content from another client",
        share_enabled: false,
        share_token: null,
        title: "Remote title",
        updated_at: "2026-07-17T12:00:00.000Z",
      },
      error: null,
    });

    const result = await persistDocumentSnapshot({
      id: "active-document",
      owner: "active-owner",
      title: "Active",
      content: "Keep",
      share_enabled: false,
      share_token: null,
      updated_at: "2026-07-17T11:00:00.000Z",
    });

    expect(result).toEqual({
      cacheUpdated: false,
      conflict: true,
      ok: false,
      persistedTitle: "Active",
      updatedAt: "2026-07-17T12:00:00.000Z",
    });
    expect(mocks.putCachedDocument).not.toHaveBeenCalled();
    expect(mocks.updateMaybeSingle).toHaveBeenCalledOnce();
  });
});
