// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkPreviewCard } from "@/components/editor/link-preview-card";
import { getLinkPreview } from "@/lib/link-preview-client";

vi.mock("@/lib/link-preview-client", () => ({ getLinkPreview: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let enterViewport: () => void;
const disconnect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) {
      enterViewport = () => callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    }
    observe() {}
    disconnect = disconnect;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("link preview card", () => {
  it("fetches near the viewport and displays an accessible linked preview", async () => {
    const onLoad = vi.fn();
    vi.mocked(getLinkPreview).mockResolvedValue({
      url: "https://example.com/story",
      title: "A useful story",
      description: "A short introduction.",
      siteName: "Example",
      image: "https://example.com/image.jpg",
    });
    await act(async () => root.render(createElement(LinkPreviewCard, {
      url: "https://example.com/story", onLoad,
    })));
    expect(getLinkPreview).not.toHaveBeenCalled();
    expect(container.querySelector("a")?.textContent).toBe("https://example.com/story");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(getLinkPreview).not.toHaveBeenCalled();
    await act(async () => enterViewport());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const link = container.querySelector("a")!;
    expect(link.className).toBe("link-preview-card");
    expect(link.textContent).toContain("A useful story");
    expect(link.textContent).toContain("A short introduction.");
    expect(link.textContent).toContain("Example · example.com");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(container.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(onLoad).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    expect(link.textContent).toContain("A useful story");
  });

  it("keeps a clickable URL when metadata cannot load", async () => {
    vi.mocked(getLinkPreview).mockResolvedValue(null);
    await act(async () => root.render(createElement(LinkPreviewCard, { url: "https://example.com" })));
    await act(async () => enterViewport());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getLinkPreview).toHaveBeenCalledTimes(1);
    expect(container.querySelector("a")?.href).toBe("https://example.com/");
    expect(container.querySelector("a")?.textContent).toBe("https://example.com");
    expect(container.querySelector(".link-preview-card")).toBeNull();
  });

  it("clears metadata when the URL changes and disconnects on unmount", async () => {
    vi.mocked(getLinkPreview).mockResolvedValue({ url: "https://example.com/first", title: "First" });
    await act(async () => root.render(createElement(LinkPreviewCard, { url: "https://example.com/first" })));
    await act(async () => enterViewport());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(container.textContent).toContain("First");
    await act(async () => root.render(createElement(LinkPreviewCard, { url: "https://example.com/second" })));
    expect(container.textContent).toBe("https://example.com/second");
    expect(getLinkPreview).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    expect(disconnect).toHaveBeenCalled();
  });

  it.each([false, true])("ignores pending loading after unmount (already visible: %s)", async (visible) => {
    vi.mocked(getLinkPreview).mockResolvedValue(null);
    await act(async () => root.render(createElement(LinkPreviewCard, { url: "https://example.com" })));
    if (visible) await act(async () => enterViewport());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => root.render(null));
    await act(async () => enterViewport());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(getLinkPreview).not.toHaveBeenCalled();
  });

  it("server-renders a link and does not request metadata", () => {
    const html = renderToStaticMarkup(createElement(LinkPreviewCard, { url: "https://example.com" }));
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain("https://example.com</a>");
    expect(getLinkPreview).not.toHaveBeenCalled();
  });
});
