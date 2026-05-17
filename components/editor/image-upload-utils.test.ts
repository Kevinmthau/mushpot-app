import { describe, expect, it } from "vitest";

import {
  ensureStorageFileNameMatchesMediaKind,
  getSupportedMediaKind,
  inferImageMimeType,
  inferMediaMimeType,
  inferVideoMimeType,
  isSupportedImageFile,
  isSupportedMediaFile,
  isSupportedVideoFile,
  isSupportedVideoUrl,
  normalizeImageMimeType,
  normalizeMediaMimeType,
  normalizeVideoMimeType,
  sanitizeImageAltText,
  sanitizeMediaAltText,
  sanitizeStorageFileName,
} from "@/components/editor/image-upload-utils";

function file(name: string, type = "") {
  return new File([], name, { type });
}

describe("inferMediaMimeType", () => {
  it("maps known extensions case-insensitively", () => {
    expect(inferMediaMimeType("photo.JPG")).toBe("image/jpeg");
    expect(inferMediaMimeType("clip.mov")).toBe("video/quicktime");
  });

  it("returns null for unknown or missing extensions", () => {
    expect(inferMediaMimeType("notes.txt")).toBeNull();
    expect(inferMediaMimeType("noextension")).toBeNull();
  });
});

describe("inferImageMimeType / inferVideoMimeType", () => {
  it("only returns a MIME type matching the requested media kind", () => {
    expect(inferImageMimeType("a.png")).toBe("image/png");
    expect(inferImageMimeType("a.mp4")).toBeNull();
    expect(inferVideoMimeType("a.mp4")).toBe("video/mp4");
    expect(inferVideoMimeType("a.png")).toBeNull();
  });
});

describe("normalizeImageMimeType / normalizeVideoMimeType", () => {
  it("normalizes the image/jpg alias and is case-insensitive", () => {
    expect(normalizeImageMimeType("image/jpg")).toBe("image/jpeg");
    expect(normalizeImageMimeType("IMAGE/PNG")).toBe("image/png");
  });

  it("returns null for unsupported or cross-kind MIME types", () => {
    expect(normalizeImageMimeType("image/tiff")).toBeNull();
    expect(normalizeImageMimeType("video/mp4")).toBeNull();
    expect(normalizeVideoMimeType("VIDEO/MP4")).toBe("video/mp4");
    expect(normalizeVideoMimeType("image/png")).toBeNull();
  });
});

describe("normalizeMediaMimeType", () => {
  it("classifies supported MIME types by kind", () => {
    expect(normalizeMediaMimeType("image/jpg")).toEqual({
      kind: "image",
      mimeType: "image/jpeg",
    });
    expect(normalizeMediaMimeType("video/mp4")).toEqual({
      kind: "video",
      mimeType: "video/mp4",
    });
  });

  it("returns null for unsupported MIME types", () => {
    expect(normalizeMediaMimeType("text/plain")).toBeNull();
  });
});

describe("getSupportedMediaKind", () => {
  it("classifies by MIME type when present", () => {
    expect(getSupportedMediaKind(file("x.png", "image/png"))).toBe("image");
    expect(getSupportedMediaKind(file("x.mov", "video/quicktime"))).toBe(
      "video",
    );
  });

  it("falls back to the file extension when MIME type is absent", () => {
    expect(getSupportedMediaKind(file("x.webp"))).toBe("image");
    expect(getSupportedMediaKind(file("x.mp4"))).toBe("video");
  });

  it("trusts the MIME type over a mismatched extension", () => {
    expect(getSupportedMediaKind(file("x.txt", "image/png"))).toBe("image");
  });

  it("returns null for unsupported files", () => {
    expect(getSupportedMediaKind(file("x.txt", "text/plain"))).toBeNull();
    expect(getSupportedMediaKind(file("noextension"))).toBeNull();
  });
});

describe("isSupportedMediaFile predicates", () => {
  it("reports support per media kind", () => {
    const image = file("x.png", "image/png");
    const video = file("x.mp4", "video/mp4");
    const other = file("x.txt", "text/plain");

    expect(isSupportedMediaFile(image)).toBe(true);
    expect(isSupportedImageFile(image)).toBe(true);
    expect(isSupportedVideoFile(image)).toBe(false);

    expect(isSupportedVideoFile(video)).toBe(true);
    expect(isSupportedImageFile(video)).toBe(false);

    expect(isSupportedMediaFile(other)).toBe(false);
  });
});

describe("isSupportedVideoUrl", () => {
  it("detects video extensions, ignoring query and hash", () => {
    expect(isSupportedVideoUrl("https://cdn.example.com/clip.mp4")).toBe(true);
    expect(isSupportedVideoUrl("https://cdn.example.com/clip.mp4?token=1")).toBe(
      true,
    );
    expect(isSupportedVideoUrl("clip.mov")).toBe(true);
  });

  it("returns false for non-video URLs", () => {
    expect(isSupportedVideoUrl("https://cdn.example.com/image.png")).toBe(false);
    expect(isSupportedVideoUrl("https://cdn.example.com/noextension")).toBe(
      false,
    );
  });
});

describe("sanitizeMediaAltText", () => {
  it("strips the extension and turns separators into spaces", () => {
    expect(sanitizeMediaAltText("my-cool_photo.png", "image")).toBe(
      "my cool photo",
    );
    expect(sanitizeImageAltText("vacation_01.jpg")).toBe("vacation 01");
  });

  it("uses the fallback when nothing meaningful remains", () => {
    expect(sanitizeMediaAltText(".png", "image")).toBe("image");
  });
});

describe("sanitizeStorageFileName", () => {
  it("lowercases and replaces disallowed characters", () => {
    expect(sanitizeStorageFileName("My Photo!.PNG")).toBe("my-photo-.png");
  });

  it("collapses repeats and trims leading/trailing dashes", () => {
    expect(sanitizeStorageFileName("--a   b--")).toBe("a-b");
  });

  it("falls back to 'file' when nothing usable remains", () => {
    expect(sanitizeStorageFileName("   ")).toBe("file");
  });
});

describe("ensureStorageFileNameMatchesMediaKind", () => {
  it("keeps the file name when the extension already matches the kind", () => {
    expect(
      ensureStorageFileNameMatchesMediaKind("photo.png", "image", "image/png"),
    ).toBe("photo.png");
  });

  it("rewrites the extension using the MIME type when it mismatches", () => {
    expect(
      ensureStorageFileNameMatchesMediaKind("upload.txt", "image", "image/png"),
    ).toBe("upload.png");
    expect(
      ensureStorageFileNameMatchesMediaKind("clip.png", "video", "video/mp4"),
    ).toBe("clip.mp4");
  });

  it("uses a kind-based default extension when no MIME type is given", () => {
    expect(
      ensureStorageFileNameMatchesMediaKind("clip", "video", null),
    ).toBe("clip.mp4");
  });
});
