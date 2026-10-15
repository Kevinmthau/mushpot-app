// @vitest-environment jsdom

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
  it("offers a copy and the shared HTML download path", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onSaveCopy = vi.fn();
    const onDownload = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(DraftSyncNotice, {
          draftSerializationError: null,
          status: "conflict",
          isCloning: false,
          isDeleting: false,
          isDownloading: false,
          onSaveCopy,
          onDownload,
        }),
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Your text is still here",
    );
    const [copyButton, downloadButton] = container.querySelectorAll("button");
    await act(async () => copyButton.click());
    expect(onSaveCopy).toHaveBeenCalledOnce();
    await act(async () => downloadButton.click());
    expect(onDownload).toHaveBeenCalledOnce();
    expect(downloadButton.textContent).toBe("Download my draft as HTML");
    await act(async () => root.unmount());
  });

  it("explains an unsavable draft without offering stale recovery actions", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () =>
      root.render(
        createElement(DraftSyncNotice, {
          draftSerializationError:
            "Undo or shorten the last change. Saving will resume automatically.",
          status: "conflict",
          isCloning: false,
          isDeleting: false,
          isDownloading: false,
          onSaveCopy: vi.fn(),
          onDownload: vi.fn(),
        }),
      ),
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "This page can’t be saved yet",
    );
    expect(container.textContent).toContain("Saving will resume automatically");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    await act(async () => root.unmount());
  });
});
