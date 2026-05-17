import { describe, expect, it } from "vitest";

import {
  appendFirstFrameFragment,
  buildVideoPosterTitle,
  parseVideoPosterFromTitle,
} from "@/lib/markdown/video-poster";

describe("buildVideoPosterTitle / parseVideoPosterFromTitle", () => {
  it("round-trips a poster URL", () => {
    const title = buildVideoPosterTitle("https://cdn.example.com/poster.jpg");
    expect(title).toBe("poster=https://cdn.example.com/poster.jpg");
    expect(parseVideoPosterFromTitle(title)).toBe(
      "https://cdn.example.com/poster.jpg",
    );
  });

  it("returns null for missing or blank titles", () => {
    expect(parseVideoPosterFromTitle(null)).toBeNull();
    expect(parseVideoPosterFromTitle(undefined)).toBeNull();
    expect(parseVideoPosterFromTitle("")).toBeNull();
  });

  it("returns null when the title is not a poster directive", () => {
    expect(parseVideoPosterFromTitle("a regular caption")).toBeNull();
    expect(parseVideoPosterFromTitle("poster=")).toBeNull();
    expect(parseVideoPosterFromTitle("poster=has space")).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseVideoPosterFromTitle("  poster=https://x/p.png  ")).toBe(
      "https://x/p.png",
    );
  });
});

describe("appendFirstFrameFragment", () => {
  it("appends a first-frame fragment when none is present", () => {
    expect(appendFirstFrameFragment("https://x/video.mp4")).toBe(
      "https://x/video.mp4#t=0.1",
    );
  });

  it("leaves URLs that already have a fragment untouched", () => {
    expect(appendFirstFrameFragment("https://x/video.mp4#t=5")).toBe(
      "https://x/video.mp4#t=5",
    );
  });
});
