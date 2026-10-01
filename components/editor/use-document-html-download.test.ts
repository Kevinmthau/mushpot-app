// @vitest-environment jsdom

import { Blob } from "node:buffer";
import { act, createElement, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDocumentHtmlDownload } from "@/components/editor/use-document-html-download";

const { exportDocumentHtml } = vi.hoisted(() => ({
  exportDocumentHtml: vi.fn(),
}));
vi.mock("@/components/editor/document-html-export", () => ({
  exportDocumentHtml,
}));

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const RESULT = { html: "<!doctype html><p>Draft</p>", filename: "Notes.html" };
const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:document-html");
const revokeObjectURL = vi.fn();

let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useDocumentHtmlDownload>;

function Probe({
  getLatestTitle = () => "Notes",
  getLatestContent = () => "Draft",
}: {
  getLatestTitle?: () => string;
  getLatestContent?: () => string;
}) {
  const download = useDocumentHtmlDownload({
    owner: OWNER_ID,
    getLatestTitle,
    getLatestContent,
  });
  useEffect(() => {
    api = download;
  });

  return createElement("button", {
    disabled: download.isDownloading,
    onClick: () => void download.handleDownload(),
  }, download.isDownloading ? "Downloading…" : "Download HTML");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Blob", Blob);
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  exportDocumentHtml.mockReset().mockResolvedValue(RESULT);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await vi.runOnlyPendingTimersAsync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mounted HTML download", () => {
  it("captures the latest draft synchronously before loading the exporter", async () => {
    let title = "Initial title";
    let content = "Initial content";
    const getLatestTitle = vi.fn(() => title);
    const getLatestContent = vi.fn(() => content);
    await act(async () => root.render(createElement(Probe, {
      getLatestTitle,
      getLatestContent,
    })));
    expect(exportDocumentHtml).not.toHaveBeenCalled();

    title = "Unsynced title";
    content = "Unsynced content";
    let downloading!: Promise<void>;
    act(() => {
      downloading = api.handleDownload();
      expect(getLatestTitle).toHaveBeenCalledOnce();
      expect(getLatestContent).toHaveBeenCalledOnce();
      expect(exportDocumentHtml).not.toHaveBeenCalled();
      title = "Typing after click";
      content = "More typing after click";
    });
    await act(async () => downloading);

    expect(exportDocumentHtml).toHaveBeenCalledWith({
      title: "Unsynced title",
      content: "Unsynced content",
      owner: OWNER_ID,
    }, { signal: expect.any(AbortSignal) });
  });

  it("uses updated getter callbacks on later renders", async () => {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => root.render(createElement(Probe, {
      getLatestTitle: () => "New title",
      getLatestContent: () => "New local content",
    })));
    await act(async () => api.handleDownload());

    expect(exportDocumentHtml).toHaveBeenCalledWith({
      title: "New title",
      content: "New local content",
      owner: OWNER_ID,
    }, { signal: expect.any(AbortSignal) });
  });

  it("prevents duplicate preparation and shows Downloading until export finishes", async () => {
    const pending = deferred<typeof RESULT>();
    exportDocumentHtml.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      void api.handleDownload();
      void api.handleDownload();
    });

    expect(exportDocumentHtml).toHaveBeenCalledOnce();
    expect(host.querySelector("button")?.textContent).toBe("Downloading…");
    expect(host.querySelector("button")?.disabled).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();

    await act(async () => pending.resolve(RESULT));
    expect(host.querySelector("button")?.textContent).toBe("Download HTML");
    expect(host.querySelector("button")?.disabled).toBe(false);
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("downloads an HTML Blob and removes the anchor before releasing its URL", async () => {
    const anchors: HTMLAnchorElement[] = [];
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (this: HTMLAnchorElement) {
      expect(document.body.contains(this)).toBe(true);
      anchors.push(this);
    });
    await act(async () => root.render(createElement(Probe)));
    await act(async () => api.handleDownload());

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/html;charset=utf-8");
    expect(await blob.text()).toBe(RESULT.html);
    expect(anchors[0].download).toBe("Notes.html");
    expect(anchors[0].href).toBe("blob:document-html");
    expect(document.body.contains(anchors[0])).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:document-html");
  });

  it("reports an actionable failure and allows retry", async () => {
    exportDocumentHtml.mockRejectedValueOnce(new Error("An uploaded image is unavailable."));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => api.handleDownload());

    expect(window.alert).toHaveBeenCalledWith(
      "Unable to download HTML. An uploaded image is unavailable. Check your connection and try again.",
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(api.isDownloading).toBe(false);

    await act(async () => api.handleDownload());
    expect(exportDocumentHtml).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(api.isDownloading).toBe(false);
  });

  it.each(["resolve", "reject"] as const)(
    "aborts preparation and suppresses stale work on unmount when export will %s",
    async (outcome) => {
      const pending = deferred<typeof RESULT>();
      exportDocumentHtml.mockReturnValueOnce(pending.promise);
      await act(async () => root.render(createElement(Probe)));
      await act(async () => {
        void api.handleDownload();
      });
      const signal = exportDocumentHtml.mock.calls[0][1].signal as AbortSignal;

      await act(async () => root.render(null));
      expect(signal.aborted).toBe(true);
      await act(async () => {
        if (outcome === "resolve") {
          pending.resolve(RESULT);
        } else {
          pending.reject(new Error("Download failed after unmount."));
        }
      });

      expect(createObjectURL).not.toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
      await act(async () => api.handleDownload());
      expect(exportDocumentHtml).toHaveBeenCalledOnce();
    },
  );

  it("does not start exporting if the editor unmounts while the chunk loads", async () => {
    await act(async () => root.render(createElement(Probe)));
    let downloading!: Promise<void>;
    act(() => {
      downloading = api.handleDownload();
      root.render(null);
    });
    await act(async () => downloading);

    expect(exportDocumentHtml).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("works after StrictMode replays mount effects", async () => {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))));
    await act(async () => api.handleDownload());

    expect(exportDocumentHtml).toHaveBeenCalledOnce();
    expect(exportDocumentHtml.mock.calls[0][1].signal.aborted).toBe(false);
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("still cleans up and permits retry if the browser download action throws", async () => {
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
      throw new Error("Download could not start.");
    });
    await act(async () => root.render(createElement(Probe)));
    await act(async () => api.handleDownload());

    expect(document.body.querySelector('a[download]')).toBeNull();
    expect(api.isDownloading).toBe(false);
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("Download could not start."));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:document-html");

    await act(async () => api.handleDownload());
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });
});
