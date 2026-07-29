import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveVideoPosterTitle } from "@/components/editor/use-image-upload";
import type { SupabaseBrowserClient } from "@/lib/supabase/client";

afterEach(() => {
  vi.restoreAllMocks();
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
