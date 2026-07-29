import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isolateVideoPosterImagePromise,
  resolveVideoPosterTitle,
} from "@/components/editor/use-image-upload";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isolateVideoPosterImagePromise", () => {
  it("handles poster rejection before a pending video upload resolves", async () => {
    const posterError = new Error("canvas extraction failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const videoUpload = createDeferred<string>();
    const posterImagePromise = isolateVideoPosterImagePromise(
      Promise.reject(posterError),
    );
    const uploadFlow = (async () => {
      const uploadedPath = await videoUpload.promise;
      const posterImage = await posterImagePromise;
      return { posterImage, uploadedPath };
    })();

    await Promise.resolve();
    expect(consoleError).toHaveBeenCalledWith(
      "Video poster generation failed",
      posterError,
    );

    videoUpload.resolve("owner/document/video.mp4");
    await expect(uploadFlow).resolves.toEqual({
      posterImage: null,
      uploadedPath: "owner/document/video.mp4",
    });
  });

  it("settles poster rejection even when the video upload fails", async () => {
    const posterError = new Error("canvas extraction failed");
    const videoError = new Error("video upload failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const posterImagePromise = isolateVideoPosterImagePromise(
      Promise.reject(posterError),
    );
    const uploadFlow = (async () => {
      await Promise.reject(videoError);
      return posterImagePromise;
    })();

    await expect(uploadFlow).rejects.toBe(videoError);
    await expect(posterImagePromise).resolves.toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      "Video poster generation failed",
      posterError,
    );
  });
});

describe("resolveVideoPosterTitle", () => {
  it("isolates poster-generation rejection after a video upload", async () => {
    const posterError = new Error("canvas extraction failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      resolveVideoPosterTitle({
        documentId: "22222222-2222-4222-8222-222222222222",
        owner: "11111111-1111-4111-8111-111111111111",
        posterImagePromise: Promise.reject(posterError),
        randomId: "33333333-3333-4333-8333-333333333333",
        supabase: {} as SupabaseBrowserClient,
      }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "Video poster generation failed",
      posterError,
    );
  });
});
