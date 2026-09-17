// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SharedDocumentMedia,
  SharedMediaProvider,
} from "@/components/editor/shared-document-media";

const source = (name: string) =>
  `/s/doc/token/m/document-images/owner/doc/${name}.png`;
let root: Root;
let container: HTMLDivElement;
const observers: Array<
  { callback: IntersectionObserverCallback; disconnected: boolean }
> = [];
const media = (name: string) =>
  createElement(SharedDocumentMedia, {
    alt: name,
    className: "media",
    video: false,
    src: source(name),
    key: name,
  });
const page = (children: React.ReactNode, token = "token") =>
  createElement(SharedMediaProvider, { documentId: "doc", token }, children);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, disconnected: false };
        observers.push(this.entry);
      }
      observe() {}
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
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
function enterViewport() {
  for (
    const observer of observers.filter((observer) => !observer.disconnected)
  ) {
    observer.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  }
}
function mockSigning() {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const { mediaUrls } = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        urls: mediaUrls.map((mediaUrl: string) => ({
          mediaUrl,
          signedUrl: `https://project.supabase.co/signed/${
            mediaUrl.split("/").pop()
          }`,
        })),
        expiresIn: 300,
      }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("shared media lifecycle", () => {
  it("keeps offscreen media idle then batches observed images", async () => {
    const fetcher = mockSigning();
    await act(async () => root.render(page([media("a"), media("b")])));
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector("img")?.hasAttribute("src")).toBe(false);
    await act(async () => {
      enterViewport();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string).mediaUrls)
      .toHaveLength(2);
    expect(container.querySelector("img")?.src).toBe(
      "https://project.supabase.co/signed/a.png",
    );
  });

  it("uses a fresh stable route on expiry errors and resets when the reference changes", async () => {
    mockSigning();
    const view = (src: string) =>
      page(
        createElement(SharedDocumentMedia, {
          alt: "Image",
          className: "media",
          video: false,
          src,
        }),
      );
    await act(async () => root.render(view(source("first"))));
    await act(async () => {
      enterViewport();
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      source("first"),
    );
    await act(async () => root.render(view(source("second"))));
    expect(container.querySelector("img")?.hasAttribute("src")).toBe(false);
    await act(async () => {
      enterViewport();
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      source("second"),
    );
    await act(async () =>
      root.render(view("https://external.example/new.png"))
    );
    expect(container.querySelector("img")?.src).toBe(
      "https://external.example/new.png",
    );
  });

  it("disconnects pending observations on unmount", async () => {
    const fetcher = mockSigning();
    await act(async () => root.render(page(media("a"))));
    await act(async () => root.render(null));
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("server-renders a stable no-JavaScript fallback without eager media requests", () => {
    mockSigning();
    const html = renderToStaticMarkup(page(media("a")));
    const [javascriptMarkup, fallback] = html.split("<noscript>");
    expect(javascriptMarkup).not.toContain("src=");
    expect(fallback).toContain(`src="${source("a")}"`);
    expect(fallback).toContain('loading="lazy"');
  });
});

it("batches a video and its poster and retries an expired playback URL", async () => {
  const fetcher = mockSigning();
  const src = "/s/doc/token/m/document-videos/owner/doc/video.mp4";
  const poster = source("poster");
  await act(async () =>
    root.render(page(createElement(SharedDocumentMedia, {
      alt: "Video",
      className: "media",
      video: true,
      src,
      poster,
    })))
  );
  expect(container.querySelector("video")?.getAttribute("preload")).toBe(
    "none",
  );
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => {
    enterViewport();
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string).mediaUrls)
    .toHaveLength(2);
  expect(container.querySelector("video")?.poster).toBe(
    "https://project.supabase.co/signed/poster.png",
  );
  await act(async () => {
    container.querySelector("video")!.dispatchEvent(new Event("error"));
  });
  expect(container.querySelector("video")?.getAttribute("src")).toBe(src);
  expect(container.querySelector("video")?.getAttribute("poster")).toBe(poster);
});
