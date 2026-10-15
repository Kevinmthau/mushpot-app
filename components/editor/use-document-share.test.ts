// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDocumentShare } from "@/components/editor/use-document-share";
import {
  type DocumentContentFormat,
  MARKDOWN_CONTENT_FORMAT,
  PAGE_JSON_CONTENT_FORMAT,
} from "@/lib/page-document";

const { getSupabaseBrowserClient } = vi.hoisted(() => ({
  getSupabaseBrowserClient: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ getSupabaseBrowserClient }));

let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useDocumentShare>;

function Probe({
  content = "Body",
  contentFormat = MARKDOWN_CONTENT_FORMAT,
  onShareUpdated = vi.fn(),
}: {
  content?: string | null;
  contentFormat?: DocumentContentFormat;
  onShareUpdated?: Parameters<typeof useDocumentShare>[0]["onShareUpdated"];
}) {
  const share = useDocumentShare({
    contentFormat,
    documentId: "document-id",
    getDocumentText: () => content,
    getDocumentTitle: () => "Title",
    onShareUpdated,
    shareEnabled: false,
    shareToken: null,
  });
  useEffect(() => {
    api = share;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getSupabaseBrowserClient.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useDocumentShare", () => {
  it("selects and returns the confirmed content format with share state", async () => {
    const onShareUpdated = vi.fn();
    const single = vi.fn(async () => ({
      data: {
        title: "Saved title",
        content: "Saved content",
        content_format: PAGE_JSON_CONTENT_FORMAT,
        updated_at: "2026-10-14T20:00:00.000Z",
      },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    getSupabaseBrowserClient.mockResolvedValue({
      from: vi.fn(() => ({ update })),
    });
    await act(async () => root.render(createElement(Probe, {
      contentFormat: PAGE_JSON_CONTENT_FORMAT,
      onShareUpdated,
    })));

    await act(async () => api.handleEnable());

    expect(select).toHaveBeenCalledWith(
      "title, content, content_format, updated_at",
    );
    expect(onShareUpdated).toHaveBeenCalledWith(
      true,
      expect.stringMatching(/^[A-Za-z0-9_-]{64}$/u),
      "2026-10-14T20:00:00.000Z",
      {
        title: "Saved title",
        content: "Saved content",
        content_format: PAGE_JSON_CONTENT_FORMAT,
      },
    );
  });

  it("copies semantic page text instead of serialized JSON", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const content = JSON.stringify({
      schema: "mushpot.page",
      version: 1,
      theme: "paper",
      width: "prose",
      content: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "Page body" }],
        }],
      },
    });
    await act(async () => root.render(createElement(Probe, {
      content,
      contentFormat: PAGE_JSON_CONTENT_FORMAT,
    })));

    await act(async () => api.handleCopyText());

    expect(writeText).toHaveBeenCalledWith("Title\n\nPage body");
  });

  it("does not copy a stale body when the latest draft is unsavable", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await act(async () =>
      root.render(createElement(Probe, { content: null })),
    );

    await act(async () => api.handleCopyText());

    expect(writeText).not.toHaveBeenCalled();
    expect(api.error).toContain("latest change can be saved");
  });
});
