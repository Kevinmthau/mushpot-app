import type { UploadOptions } from "tus-js-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadDocumentMedia } from "@/components/editor/media-upload";

const transport = vi.hoisted(() => ({
  upload: vi.fn(),
  poster: vi.fn(),
  lookup: vi.fn(),
  start: vi.fn(),
  abort: vi.fn(),
  resume: vi.fn(),
  options: null as UploadOptions | null,
}));
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "session-token" } }, error: null }) },
    storage: { from: () => ({ upload: transport.upload }) },
  }),
}));
vi.mock("@/components/editor/video-poster-utils", () => ({ generateVideoPosterImage: transport.poster }));
vi.mock("tus-js-client", () => ({
  Upload: class {
    constructor(_file: File, readonly options: UploadOptions) { transport.options = options; }
    findPreviousUploads = transport.lookup;
    start = transport.start;
    abort = transport.abort;
    resumeFromPreviousUpload = transport.resume;
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
}

function image(bytes = 5) {
  const file = new File(["image"], "my-photo.jpg", { type: "image/jpeg" });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

function upload(file = image(), signal = new AbortController().signal) {
  return uploadDocumentMedia({ documentId: "doc", owner: "owner", file, signal });
}

beforeEach(() => {
  transport.upload.mockReset().mockResolvedValue({ error: null });
  transport.poster.mockReset().mockResolvedValue(null);
  transport.lookup.mockReset().mockResolvedValue([]);
  transport.start.mockReset();
  transport.abort.mockReset().mockResolvedValue(undefined);
  transport.resume.mockReset();
  transport.options = null;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-public-key");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("media upload service", () => {
  it("returns stable media metadata and preserves standard upload options", async () => {
    const result = await upload();
    expect(result).toEqual({
      status: "uploaded",
      media: { url: expect.stringMatching(/^\/m\/document-images\/owner\/doc\/.+-my-photo\.jpg$/), altText: "my photo", posterTitle: undefined },
    });
    expect(transport.upload).toHaveBeenCalledWith(expect.any(String), expect.any(File), {
      cacheControl: "300", contentType: "image/jpeg", upsert: false,
    });
  });

  it("rejects oversized files before starting storage work", async () => {
    expect(await upload(image(11 * 1024 * 1024))).toMatchObject({
      status: "failed", message: expect.stringContaining("Image uploads are limited to 10MB"),
    });
    expect(transport.upload).not.toHaveBeenCalled();
  });

  it("does not start a cancelled job", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await upload(image(), controller.signal)).toEqual({ status: "cancelled" });
    expect(transport.upload).not.toHaveBeenCalled();
  });

  it("settles cancellation immediately and observes a late small-upload rejection", async () => {
    const pending = deferred<{ error: null }>();
    transport.upload.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const result = upload(image(), controller.signal);
    await vi.waitFor(() => expect(transport.upload).toHaveBeenCalledOnce());
    controller.abort();
    expect(await result).toEqual({ status: "cancelled" });
    pending.reject(new Error("late network failure"));
    await Promise.resolve();
  });

  it("stops a resumable request and keeps its fingerprint available for resuming", async () => {
    const controller = new AbortController();
    const result = upload(image(7 * 1024 * 1024), controller.signal);
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledOnce());
    expect(transport.options).toMatchObject({
      endpoint: "https://project.storage.supabase.co/storage/v1/upload/resumable",
      chunkSize: 6 * 1024 * 1024,
      removeFingerprintOnSuccess: true,
    });
    controller.abort();
    expect(await result).toEqual({ status: "cancelled" });
    expect(transport.abort).toHaveBeenCalledWith();
    expect(transport.upload).not.toHaveBeenCalled();
  });

  it("cannot start TUS after cancellation during previous-upload discovery", async () => {
    const pending = deferred<[]>();
    transport.lookup.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const result = upload(image(7 * 1024 * 1024), controller.signal);
    await vi.waitFor(() => expect(transport.lookup).toHaveBeenCalledOnce());
    controller.abort();
    expect(await result).toEqual({ status: "cancelled" });
    pending.resolve([]);
    await Promise.resolve();
    expect(transport.start).not.toHaveBeenCalled();
  });

  it("resumes the existing path only within the same document and bucket", async () => {
    const previous = { metadata: { bucketName: "document-images", objectName: "owner/doc/existing.jpg" } };
    transport.lookup.mockResolvedValue([
      { metadata: { bucketName: "document-images", objectName: "owner/other/other.jpg" } },
      previous,
    ]);
    const result = upload(image(7 * 1024 * 1024));
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledOnce());
    expect(transport.resume).toHaveBeenCalledWith(previous);
    const request = { setHeader: vi.fn() };
    await transport.options!.onBeforeRequest!(request as never);
    expect(request.setHeader).toHaveBeenCalledWith("authorization", "Bearer session-token");
    transport.options!.onSuccess!({} as never);
    expect(await result).toMatchObject({ status: "uploaded", media: { url: "/m/document-images/owner/doc/existing.jpg" } });
  });

  it("retains a successfully uploaded video when its optional poster fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    transport.poster.mockRejectedValueOnce(new Error("decode failed"));
    const result = await upload(new File(["video"], "clip.mp4", { type: "video/mp4" }));
    expect(result).toMatchObject({ status: "uploaded", media: { altText: "clip", posterTitle: undefined } });
    expect(transport.upload).toHaveBeenCalledOnce();
  });
});
