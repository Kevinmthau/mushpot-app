// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageEditor } from "@/components/editor/page-editor";
import {
  PAGE_JSON_CONTENT_FORMAT,
  parsePageDocument,
  serializePageDocument,
} from "@/lib/page-document";

const CONTENT = serializePageDocument({
  schema: "mushpot.page",
  version: 1,
  theme: "paper",
  width: "prose",
  content: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Structured prose" }],
      },
    ],
  },
});

describe("structured page editor", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("edits a page model without exposing its JSON and persists design changes", async () => {
    const onChange = vi.fn();
    const onReady = vi.fn();

    await act(async () => {
      root.render(createElement(PageEditor, {
        documentId: "22222222-2222-4222-8222-222222222222",
        initialValue: CONTENT,
        onChange,
        onReady,
        owner: "11111111-1111-4111-8111-111111111111",
      }));
    });

    await vi.waitFor(() => {
      expect(host.querySelector(".ProseMirror")?.textContent).toBe(
        "Structured prose",
      );
    });
    expect(host.textContent).not.toContain("mushpot.page");
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({
      focus: expect.any(Function),
    }));

    const theme = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Page theme"]',
    )!;
    await act(async () => {
      theme.value = "editorial";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledOnce();
    const serialized = String(onChange.mock.calls[0][0]);
    expect(parsePageDocument(serialized)).toMatchObject({
      theme: "editorial",
      width: "prose",
    });
    expect(PAGE_JSON_CONTENT_FORMAT).toBe("page_json_v1");
    expect(host.querySelector(".page-editor-shell")?.getAttribute("data-page-theme"))
      .toBe("editorial");
  });

  it("keeps ordinary rich HTML paste serializable", async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(createElement(PageEditor, {
        documentId: "22222222-2222-4222-8222-222222222222",
        initialValue: CONTENT,
        onChange,
        owner: "11111111-1111-4111-8111-111111111111",
      }));
    });

    const editor = await vi.waitFor(() => {
      const element = host.querySelector<HTMLElement>(".ProseMirror");
      expect(element).not.toBeNull();
      return element!;
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => {
          if (type === "text/html") {
            return '<p><a href="https://example.com" target="_self" rel="nofollow" class="source-link">Pasted link</a></p><img src="https://example.com/photo.png" width="640">';
          }
          return type === "text/plain" ? "Pasted link" : "";
        },
      },
    });

    await act(async () => {
      editor.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalled();
    const saved = parsePageDocument(String(onChange.mock.lastCall?.[0]));
    expect(saved.content.content?.slice(0, 2)).toMatchObject([
      {
        content: [
          {
            marks: [
              {
                attrs: { href: "https://example.com" },
                type: "link",
              },
            ],
            text: "Pasted link",
          },
        ],
        type: "paragraph",
      },
      {
        attrs: {
          src: "https://example.com/photo.png",
          width: 640,
        },
        type: "image",
      },
    ]);
  });
});
