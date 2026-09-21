// @vitest-environment jsdom

import { Blob } from "node:buffer";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DraftSyncNotice } from "@/components/editor/draft-sync-notice";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("conflict recovery actions", () => {
  it("offers a copy and downloads the current text, including edits after the notice rendered", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("Blob", Blob);
    vi.useFakeTimers();
    let download: Blob | undefined;
    const createObjectURL = vi.fn((blob: Blob) => {
      download = blob;
      return "blob:local-draft";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const onSaveCopy = vi.fn();
    let text = "Initial local text";
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(DraftSyncNotice, {
          status: "conflict",
          isCloning: false,
          isDeleting: false,
          onSaveCopy,
          getLatestTitle: () => "Notes/weekend",
          getLatestContent: () => text,
        }),
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Your text is still here",
    );
    const [copyButton, downloadButton] = container.querySelectorAll("button");
    await act(async () => copyButton.click());
    expect(onSaveCopy).toHaveBeenCalledOnce();
    text = "More typing after the conflict";
    await act(async () => downloadButton.click());
    expect(await download?.text()).toBe(
      "# Notes/weekend\n\nMore typing after the conflict",
    );
    expect((anchorClick.mock.instances[0] as HTMLAnchorElement).download).toBe(
      "Notes_weekend.md",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:local-draft");
    await act(async () => root.unmount());
  });
});
