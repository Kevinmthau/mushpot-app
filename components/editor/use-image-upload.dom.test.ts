// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { act, createElement, StrictMode } from "react";
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

function Probe({ documentId = "first", placeholder = "Write" }: {
  documentId?: string;
  placeholder?: string;
}) {
  const { mediaUploadExtensions, uploadingMediaCount } = useMediaUploadInsertion({
    documentId, owner: "owner",
  });
  return createElement("div", null,
    createElement("output", null, uploadingMediaCount),
    createElement(CodeMirrorEditor, {
      documentId,
      initialValue: "Body",
      placeholder,
      extensions: mediaUploadExtensions,
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
