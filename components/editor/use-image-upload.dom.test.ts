// @vitest-environment jsdom

import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { act, createElement, createRef, StrictMode, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeMirrorEditor } from "@/components/editor/code-mirror-editor";
import { useMediaUploadInsertion } from "@/components/editor/use-image-upload";

const { upload, generatePoster } = vi.hoisted(() => ({
  upload: vi.fn(),
  generatePoster: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowserClient: async () => ({ storage: { from: () => ({ upload }) } }),
}));
vi.mock("@/components/editor/video-poster-utils", () => ({
  generateVideoPosterImage: generatePoster,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

let root: Root;
let host: HTMLDivElement;

class MediaWidget extends WidgetType {
  toDOM() {
    const element = document.createElement("img");
    element.dataset.testid = "media-widget";
    element.alt = "Existing image";
    return element;
  }
}

const mediaWidget = new MediaWidget();
const widgetExtension = EditorView.decorations.of(Decoration.set([
  Decoration.replace({ widget: mediaWidget }).range(0, 4),
]));

function Probe({ documentId = "first", placeholder = "Write", withDropTarget = false,
  withWidget = false }: {
  documentId?: string;
  placeholder?: string;
  withDropTarget?: boolean;
  withWidget?: boolean;
}) {
  const [dropTargetRef] = useState(() => createRef<HTMLDivElement>());
  const { mediaUploadExtensions, uploadingMediaCount, isDraggingMedia } = useMediaUploadInsertion({
    documentId, owner: "owner",
    dropTargetRef: withDropTarget ? dropTargetRef : undefined,
  });
  const extensions = useMemo(() => withWidget
    ? [...mediaUploadExtensions, widgetExtension]
    : mediaUploadExtensions, [mediaUploadExtensions, withWidget]);
  return createElement("div", { ref: dropTargetRef, "data-testid": "document" },
    createElement("input", { "data-testid": "title", defaultValue: "Title" }),
    createElement("output", { "data-testid": "upload-count" }, uploadingMediaCount),
    createElement("output", { "data-testid": "dragging" }, String(isDraggingMedia)),
    createElement(CodeMirrorEditor, {
      documentId,
      initialValue: "Body",
      placeholder,
      extensions,
    }),
  );
}

function editor() {
  return EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
}

async function paste(files: File[]) {
  await act(async () => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files } });
    editor().contentDOM.dispatchEvent(event);
  });
}

function image(name = "photo.jpg") {
  return new File(["image"], name, { type: "image/jpeg" });
}

function title() {
  return host.querySelector<HTMLInputElement>('[data-testid="title"]')!;
}

function dragging() {
  return host.querySelector('[data-testid="dragging"]')?.textContent;
}

async function drag(type: string, target: Element, {
  files = [image()], types = ["Files"], clientY = 150, relatedTarget = null,
}: {
  files?: File[];
  types?: string[];
  clientY?: number;
  relatedTarget?: EventTarget | null;
} = {}) {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: 20, clientY, relatedTarget,
  });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types, dropEffect: "none", getData: () => "" },
  });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

function setEditorBounds() {
  vi.spyOn(editor().dom, "getBoundingClientRect").mockReturnValue({
    top: 100, bottom: 200, left: 0, right: 500, height: 100, width: 500,
    x: 0, y: 100, toJSON: () => ({}),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  upload.mockReset().mockResolvedValue({ error: null });
  generatePoster.mockReset().mockResolvedValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mounted media upload insertion", () => {
  it("captures file drops on rendered widgets before CodeMirror ignores their events", async () => {
    await act(async () => root.render(createElement(Probe, { withWidget: true })));
    const view = editor();
    setEditorBounds();
    vi.spyOn(view, "posAtCoords").mockReturnValue(4);
    const widget = host.querySelector('[data-testid="media-widget"]')!;
    const bubble = vi.fn();
    host.addEventListener("drop", bubble);

    expect(mediaWidget.ignoreEvent(new Event("drop"))).toBe(true);
    const event = await drag("drop", widget);

    expect(event.defaultPrevented).toBe(true);
    expect(bubble).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toMatch(/^Body\n!\[photo\]/);
  });

  it.each([
    { location: "title", clientY: 50, expected: /^!\[photo\].+\n\nBody$/ },
    { location: "space below the body", clientY: 250, expected: /^Body\n!\[photo\].+\n$/ },
  ])("inserts media dropped on $location into the document body", async ({ location, clientY, expected }) => {
    await act(async () => root.render(createElement(Probe, { withDropTarget: true })));
    setEditorBounds();
    const position = vi.spyOn(editor(), "posAtCoords").mockReturnValue(2);
    const target = location === "title" ? title() : host.querySelector('[data-testid="document"]')!;

    const event = await drag("drop", target, { clientY });

    expect(event.defaultPrevented).toBe(true);
    expect(position).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledOnce();
    expect(editor().state.doc.toString()).toMatch(expected);
    expect(title().value).toBe("Title");
  });

  it("inserts several dropped images in file order with one upload each", async () => {
    await act(async () => root.render(createElement(Probe, { withDropTarget: true })));
    setEditorBounds();

    await drag("drop", title(), { files: [image("first.jpg"), image("second.jpg")], clientY: 50 });

    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map((call) => (call[1] as File).name)).toEqual(["first.jpg", "second.jpg"]);
    expect(editor().state.doc.toString()).toMatch(/^!\[first\].+\n\n!\[second\].+\n\nBody$/);
    expect(host.querySelector('[data-testid="upload-count"]')?.textContent).toBe("0");
  });

  it("keeps a pending drop at its mapped position when typing changes the document", async () => {
    const pending = deferred<{ error: null }>();
    upload.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe)));
    const view = editor();
    setEditorBounds();
    vi.spyOn(view, "posAtCoords").mockReturnValue(2);
    view.dispatch({ selection: { anchor: 0 } });

    await drag("drop", view.contentDOM);
    expect(host.querySelector('[data-testid="upload-count"]')?.textContent).toBe("1");
    view.dispatch({ changes: { from: 0, insert: "New " } });
    await act(async () => pending.resolve({ error: null }));

    expect(view.state.doc.toString()).toMatch(/^New Bo\n!\[photo\].+\n\ndy$/);
    expect(host.querySelector('[data-testid="upload-count"]')?.textContent).toBe("0");
  });

  it("shows file drag feedback across document children and clears it on leave or drop", async () => {
    await act(async () => root.render(createElement(Probe, { withDropTarget: true })));
    const documentTarget = host.querySelector('[data-testid="document"]')!;
    setEditorBounds();

    await drag("dragenter", documentTarget, { files: [] });
    expect(dragging()).toBe("true");
    const over = await drag("dragover", title(), { files: [] });
    expect(over.defaultPrevented).toBe(true);
    expect((over as MouseEvent & { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe("copy");
    await drag("dragenter", title(), { files: [] });
    await drag("dragleave", title(), { files: [], relatedTarget: editor().contentDOM });
    expect(dragging()).toBe("true");
    await drag("dragleave", documentTarget, { files: [], relatedTarget: document.body });
    expect(dragging()).toBe("false");

    await drag("dragenter", title(), { files: [] });
    expect(dragging()).toBe("true");
    await drag("drop", title(), { clientY: 50 });
    expect(dragging()).toBe("false");
    expect(upload).toHaveBeenCalledOnce();
  });

  it("clears drag feedback and detaches the previous editor's listeners when switching documents", async () => {
    await act(async () => root.render(createElement(Probe)));
    const oldView = editor();
    await drag("dragenter", oldView.dom, { files: [] });
    expect(dragging()).toBe("true");

    await act(async () => root.render(createElement(Probe, { documentId: "second" })));
    expect(dragging()).toBe("false");
    const staleDrop = await drag("drop", oldView.dom);
    expect(staleDrop.defaultPrevented).toBe(false);
    expect(upload).not.toHaveBeenCalled();

    setEditorBounds();
    vi.spyOn(editor(), "posAtCoords").mockReturnValue(4);
    await drag("drop", editor().contentDOM);
    expect(upload).toHaveBeenCalledOnce();
    expect(editor().state.doc.toString()).toContain("/owner/second/");
  });

  it("leaves text drags and drops available to the document's normal handlers", async () => {
    await act(async () => root.render(createElement(Probe, { withDropTarget: true })));
    const bubble = vi.fn();
    host.addEventListener("drop", bubble);
    const textTransfer = { files: [], types: ["text/plain"] };

    await drag("dragenter", title(), textTransfer);
    const over = await drag("dragover", title(), textTransfer);
    const drop = await drag("drop", title(), textTransfer);

    expect(dragging()).toBe("false");
    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(bubble).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("prevents navigation for unsupported file drops without uploading them", async () => {
    await act(async () => root.render(createElement(Probe, { withDropTarget: true })));
    const bubble = vi.fn();
    host.addEventListener("drop", bubble);
    await drag("dragenter", title(), { files: [] });

    const event = await drag("drop", title(), {
      files: [new File(["document"], "notes.pdf", { type: "application/pdf" })],
    });

    expect(event.defaultPrevented).toBe(true);
    expect(bubble).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledOnce();
    expect(dragging()).toBe("false");
    expect(editor().state.doc.toString()).toBe("Body");
  });

  it("inserts uploaded media after StrictMode replays the hook and editor effects", async () => {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))));
    await paste([image()]);

    expect(upload).toHaveBeenCalledOnce();
    expect(editor().state.doc.toString()).toMatch(/!\[photo\]\(\/m\/document-images\/owner\/first\/.+-photo\.jpg\)/);
    expect(host.querySelector("output")?.textContent).toBe("0");
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("maps the insertion position through edits while an upload is pending", async () => {
    const pending = deferred<{ error: null }>();
    upload.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe)));
    const view = editor();
    view.dispatch({ selection: { anchor: 4 } });
    await paste([image()]);
    expect(host.querySelector("output")?.textContent).toBe("1");

    view.dispatch({ changes: { from: 0, insert: "New " } });
    await act(async () => pending.resolve({ error: null }));

    expect(view.state.doc.toString()).toMatch(/^New Body\n!\[photo\]/);
    expect(host.querySelector("output")?.textContent).toBe("0");
  });

  it("cancels on unmount and never inserts, uploads a poster, or starts the next file", async () => {
    const pendingUpload = deferred<{ error: null }>();
    const pendingPoster = deferred<File | null>();
    upload.mockReturnValueOnce(pendingUpload.promise);
    generatePoster.mockReturnValueOnce(pendingPoster.promise);
    await act(async () => root.render(createElement(Probe)));
    const view = editor();
    const dispatch = vi.spyOn(view, "dispatch");
    await paste([new File(["video"], "clip.mp4", { type: "video/mp4" }), image()]);
    const posterSignal = generatePoster.mock.calls[0][1] as AbortSignal;

    await act(async () => root.render(null));
    expect(posterSignal.aborted).toBe(true);
    await act(async () => {
      pendingUpload.resolve({ error: null });
      pendingPoster.resolve(image("poster.jpg"));
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("isolates pending uploads and the count when switching documents", async () => {
    const pending = deferred<{ error: null }>();
    upload.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe)));
    const oldView = editor();
    const dispatch = vi.spyOn(oldView, "dispatch");
    await paste([image("old.jpg")]);

    await act(async () => root.render(createElement(Probe, { documentId: "second" })));
    expect(host.querySelector("output")?.textContent).toBe("0");
    await paste([image("new.jpg")]);
    await act(async () => pending.resolve({ error: null }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(editor().state.doc.toString()).toContain("/owner/second/");
    expect(editor().state.doc.toString()).not.toContain("old.jpg");
    expect(host.querySelector("output")?.textContent).toBe("0");
  });

  it("cancels the old view's uploads if the editor is recreated for the same document", async () => {
    const pending = deferred<{ error: null }>();
    upload.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe)));
    const oldView = editor();
    const dispatch = vi.spyOn(oldView, "dispatch");
    await paste([image()]);

    await act(async () => root.render(createElement(Probe, { placeholder: "New placeholder" })));
    expect(editor()).not.toBe(oldView);
    await act(async () => pending.resolve({ error: null }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(editor().state.doc.toString()).toBe("Body");
    expect(host.querySelector("output")?.textContent).toBe("0");
  });
});
