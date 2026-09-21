// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateVideoPosterImage } from "@/components/editor/video-poster-utils";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("video poster cancellation", () => {
  it("releases the object URL, video source, and timeout when aborted", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:video");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const createElement = vi.spyOn(document, "createElement");
    const controller = new AbortController();
    const pending = generateVideoPosterImage(new File(["video"], "clip.mp4"), controller.signal);
    const video = createElement.mock.results[0].value as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe("blob:video");

    controller.abort();
    expect(await pending).toBeNull();
    expect(video.hasAttribute("src")).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:video");
    expect(vi.getTimerCount()).toBe(0);
    video.dispatchEvent(new Event("seeked"));
    expect(createElement).toHaveBeenCalledOnce();
  });
});
