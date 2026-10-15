"use client";

import type { Editor, JSONContent } from "@tiptap/core";
import FileHandler from "@tiptap/extension-file-handler";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from "react";

import {
  PAGE_EDITOR_EXTENSIONS,
} from "@/components/editor/page-editor-extensions";
import {
  getSupportedMediaKind,
  isSupportedMediaFile,
  SUPPORTED_MEDIA_FORMATS_LABEL,
} from "@/components/editor/image-upload-utils";
import { uploadDocumentMedia } from "@/components/editor/media-upload";
import type { DocumentTextSource } from "@/components/editor/read-document-text";
import { parseVideoPosterFromTitle } from "@/lib/markdown/video-poster";
import {
  isSafePageLinkUrl,
  parsePageDocument,
  serializePageDocument,
  type PageDocumentTheme,
  type PageDocumentV1,
  type PageDocumentWidth,
} from "@/lib/page-document";

type PageEditorApi = {
  focus: () => void;
};

type PageEditorProps = {
  documentId: string;
  dropTargetRef?: RefObject<HTMLElement | null>;
  initialValue: string;
  onChange: (source: DocumentTextSource) => void;
  onReady?: (api: PageEditorApi | null) => void;
  onUploadingMediaCountChange?: (count: number) => void;
  owner: string;
};

type PageSnapshotSourceOptions = Pick<PageDocumentV1, "theme" | "width"> & {
  content: JSONContent;
};

/** Defers validation and JSON serialization until cache/save actually reads it. */
export function createPageSnapshotSource(
  snapshot: PageSnapshotSourceOptions,
): DocumentTextSource {
  let serialized: string | undefined;

  return {
    toString() {
      serialized ??= serializePageDocument({
        schema: "mushpot.page",
        version: 1,
        theme: snapshot.theme,
        width: snapshot.width,
        content: snapshot.content,
      });
      return serialized;
    },
  };
}

function ToolbarButton({
  active,
  disabled = false,
  label,
  onClick,
  title,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      title={title}
      className="page-toolbar-button"
    >
      {label}
    </button>
  );
}

function PageEditorToolbar({
  editor,
  onChooseMedia,
  onThemeChange,
  onWidthChange,
  theme,
  width,
}: {
  editor: Editor | null;
  onChooseMedia: () => void;
  onThemeChange: (theme: PageDocumentTheme) => void;
  onWidthChange: (width: PageDocumentWidth) => void;
  theme: PageDocumentTheme;
  width: PageDocumentWidth;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      blockquote: current?.isActive("blockquote") ?? false,
      bold: current?.isActive("bold") ?? false,
      bulletList: current?.isActive("bulletList") ?? false,
      code: current?.isActive("code") ?? false,
      heading1: current?.isActive("heading", { level: 1 }) ?? false,
      heading2: current?.isActive("heading", { level: 2 }) ?? false,
      heading3: current?.isActive("heading", { level: 3 }) ?? false,
      italic: current?.isActive("italic") ?? false,
      link: current?.isActive("link") ?? false,
      orderedList: current?.isActive("orderedList") ?? false,
      strike: current?.isActive("strike") ?? false,
      table: current?.isActive("table") ?? false,
      underline: current?.isActive("underline") ?? false,
    }),
  });

  const setLink = useCallback(() => {
    if (!editor) return;
    const previous = String(editor.getAttributes("link").href ?? "");
    const href = window.prompt("Link URL", previous);
    if (href === null) return;
    if (!href.trim()) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const normalizedHref = href.trim();
    if (!isSafePageLinkUrl(normalizedHref)) {
      window.alert("Use a safe web, email, phone, or relative link.");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({
      href: normalizedHref,
    }).run();
  }, [editor]);

  const disabled = !editor;

  return (
    <div className="page-toolbar" role="toolbar" aria-label="Page formatting">
      <div className="page-toolbar-group" aria-label="Text style">
        <ToolbarButton
          active={state?.heading1}
          disabled={disabled}
          label="H1"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
          title="Heading 1"
        />
        <ToolbarButton
          active={state?.heading2}
          disabled={disabled}
          label="H2"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Heading 2"
        />
        <ToolbarButton
          active={state?.heading3}
          disabled={disabled}
          label="H3"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
          title="Heading 3"
        />
        <ToolbarButton
          active={state?.bold}
          disabled={disabled}
          label="B"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          title="Bold"
        />
        <ToolbarButton
          active={state?.italic}
          disabled={disabled}
          label="I"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          title="Italic"
        />
        <ToolbarButton
          active={state?.underline}
          disabled={disabled}
          label="U"
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
          title="Underline"
        />
        <ToolbarButton
          active={state?.strike}
          disabled={disabled}
          label="S"
          onClick={() => editor?.chain().focus().toggleStrike().run()}
          title="Strikethrough"
        />
        <ToolbarButton
          active={state?.code}
          disabled={disabled}
          label="Code"
          onClick={() => editor?.chain().focus().toggleCode().run()}
          title="Inline code"
        />
      </div>

      <div className="page-toolbar-group" aria-label="Blocks and links">
        <ToolbarButton
          active={state?.bulletList}
          disabled={disabled}
          label="• List"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          title="Bulleted list"
        />
        <ToolbarButton
          active={state?.orderedList}
          disabled={disabled}
          label="1. List"
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        />
        <ToolbarButton
          active={state?.blockquote}
          disabled={disabled}
          label="Quote"
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          title="Block quote"
        />
        <ToolbarButton
          active={state?.link}
          disabled={disabled}
          label="Link"
          onClick={setLink}
          title="Add or edit link"
        />
        <ToolbarButton
          disabled={disabled}
          label="Rule"
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
          title="Horizontal rule"
        />
        <ToolbarButton
          disabled={disabled}
          label="Table"
          onClick={() => editor?.chain().focus().insertTable({
            rows: 3,
            cols: 3,
            withHeaderRow: true,
          }).run()}
          title="Insert table"
        />
        {state?.table ? (
          <ToolbarButton
            disabled={disabled}
            label="Delete table"
            onClick={() => editor?.chain().focus().deleteTable().run()}
            title="Delete current table"
          />
        ) : null}
        <ToolbarButton
          disabled={disabled}
          label="Media"
          onClick={onChooseMedia}
          title="Add images or videos"
        />
      </div>

      <div className="page-toolbar-group page-toolbar-settings" aria-label="Page design">
        <label>
          <span className="sr-only">Page theme</span>
          <select
            aria-label="Page theme"
            value={theme}
            onChange={(event) => onThemeChange(event.target.value as PageDocumentTheme)}
          >
            <option value="paper">Paper</option>
            <option value="editorial">Editorial</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Page width</span>
          <select
            aria-label="Page width"
            value={width}
            onChange={(event) => onWidthChange(event.target.value as PageDocumentWidth)}
          >
            <option value="prose">Prose</option>
            <option value="wide">Wide</option>
          </select>
        </label>
      </div>
    </div>
  );
}

export function PageEditor({
  documentId,
  dropTargetRef,
  initialValue,
  onChange,
  onReady,
  onUploadingMediaCountChange,
  owner,
}: PageEditorProps) {
  const initialDocument = useMemo(
    () => parsePageDocument(initialValue),
    // The component is keyed by document ID. Hydration changes are applied by
    // the effect below, without recreating the editor or its undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentId],
  );
  const [theme, setTheme] = useState(initialDocument.theme);
  const [width, setWidth] = useState(initialDocument.width);
  const [uploadingMediaCount, setUploadingMediaCount] = useState(0);
  const [isDraggingMedia, setIsDraggingMedia] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef(true);
  const uploadControllersRef = useRef(new Set<AbortController>());
  const applyingExternalValueRef = useRef(false);
  const hasLocalEditsRef = useRef(false);
  const lastExternalValueRef = useRef(initialValue);
  const onChangeRef = useRef(onChange);
  const themeRef = useRef<PageDocumentTheme>(initialDocument.theme);
  const widthRef = useRef<PageDocumentWidth>(initialDocument.width);
  const uploadFilesRef = useRef<(
    editor: Editor,
    files: File[],
    position?: number,
  ) => void>(() => {});

  onChangeRef.current = onChange;

  const extensions = useMemo(
    () => [
      ...PAGE_EDITOR_EXTENSIONS,
      FileHandler.configure({
        consumePasteEvent: true,
        onDrop: (currentEditor, files, position) => {
          uploadFilesRef.current(currentEditor, files, position);
        },
        onPaste: (currentEditor, files) => {
          uploadFilesRef.current(currentEditor, files);
        },
      }),
    ],
    [],
  );

  const editor = useEditor({
    content: initialDocument.content,
    editorProps: {
      attributes: {
        "aria-label": "Page body",
        autocapitalize: "sentences",
        class: "page-body page-editor-content",
      },
    },
    extensions,
    immediatelyRender: false,
    onUpdate: ({ editor: currentEditor }) => {
      if (applyingExternalValueRef.current) return;
      hasLocalEditsRef.current = true;
      onChangeRef.current(createPageSnapshotSource({
        content: currentEditor.getJSON(),
        theme: themeRef.current,
        width: widthRef.current,
      }));
    },
  });

  const uploadFiles = useCallback(async (
    currentEditor: Editor,
    files: File[],
    initialPosition?: number,
  ) => {
    const supported = files.filter(isSupportedMediaFile);
    if (supported.length !== files.length) {
      window.alert(
        `Only image and video files are supported. Allowed formats: ${SUPPORTED_MEDIA_FORMATS_LABEL}.`,
      );
    }
    if (supported.length === 0) return;

    setUploadingMediaCount((count) => count + supported.length);
    const failures: string[] = [];
    let position = initialPosition;

    try {
      for (const file of supported) {
        const controller = new AbortController();
        uploadControllersRef.current.add(controller);
        try {
          const result = await uploadDocumentMedia({
            documentId,
            owner,
            file,
            signal: controller.signal,
          });
          if (!activeRef.current || result.status === "cancelled") return;
          if (result.status === "failed") {
            failures.push(result.message);
            continue;
          }

          const kind = getSupportedMediaKind(file);
          const node = kind === "video"
            ? {
                type: "video",
                attrs: {
                  src: result.media.url,
                  alt: result.media.altText,
                  poster: result.media.posterTitle
                    ? parseVideoPosterFromTitle(result.media.posterTitle)
                    : null,
                },
              }
            : {
                type: "image",
                attrs: {
                  src: result.media.url,
                  alt: result.media.altText,
                },
              };
          const content = [node, { type: "paragraph" }];
          const chain = currentEditor.chain().focus();
          const inserted = typeof position === "number"
            ? chain.insertContentAt(
                Math.min(position, currentEditor.state.doc.content.size),
                content,
              ).run()
            : chain.insertContent(content).run();
          if (inserted) position = currentEditor.state.selection.anchor;
        } finally {
          uploadControllersRef.current.delete(controller);
          if (activeRef.current) {
            setUploadingMediaCount((count) => Math.max(0, count - 1));
          }
        }
      }
    } finally {
      if (activeRef.current && failures.length > 0) {
        window.alert(failures.join("\n"));
      }
    }
  }, [documentId, owner]);
  uploadFilesRef.current = (currentEditor, files, position) => {
    void uploadFiles(currentEditor, files, position);
  };

  useEffect(() => {
    onUploadingMediaCountChange?.(uploadingMediaCount);
  }, [onUploadingMediaCountChange, uploadingMediaCount]);

  useEffect(() => {
    activeRef.current = true;
    const uploadControllers = uploadControllersRef.current;
    return () => {
      activeRef.current = false;
      for (const controller of uploadControllers) controller.abort();
      uploadControllers.clear();
      onUploadingMediaCountChange?.(0);
    };
  }, [onUploadingMediaCountChange]);

  useEffect(() => {
    if (!editor) return;
    const api = { focus: () => editor.commands.focus("start") };
    onReady?.(api);
    return () => onReady?.(null);
  }, [editor, onReady]);

  useEffect(() => {
    if (!editor || initialValue === lastExternalValueRef.current) return;
    lastExternalValueRef.current = initialValue;
    if (hasLocalEditsRef.current) return;

    const next = parsePageDocument(initialValue);
    applyingExternalValueRef.current = true;
    try {
      themeRef.current = next.theme;
      widthRef.current = next.width;
      setTheme(next.theme);
      setWidth(next.width);
      editor.commands.setContent(next.content, { emitUpdate: false });
    } finally {
      applyingExternalValueRef.current = false;
    }
  }, [editor, initialValue]);

  useEffect(() => {
    const target = dropTargetRef?.current;
    if (!target || !editor) return;
    let depth = 0;
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const reset = () => {
      depth = 0;
      setIsDraggingMedia(false);
    };
    const dragenter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setIsDraggingMedia(true);
    };
    const dragover = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const dragleave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDraggingMedia(false);
    };
    const drop = (event: DragEvent) => {
      reset();
      if (editor.view.dom.contains(event.target as Node)) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      const found = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      void uploadFiles(editor, files, found?.pos ?? editor.state.selection.anchor);
    };
    target.addEventListener("dragenter", dragenter, true);
    target.addEventListener("dragover", dragover, true);
    target.addEventListener("dragleave", dragleave, true);
    target.addEventListener("drop", drop, true);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      target.removeEventListener("dragenter", dragenter, true);
      target.removeEventListener("dragover", dragover, true);
      target.removeEventListener("dragleave", dragleave, true);
      target.removeEventListener("drop", drop, true);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [dropTargetRef, editor, uploadFiles]);

  const updateDesign = useCallback((next: {
    theme?: PageDocumentTheme;
    width?: PageDocumentWidth;
  }) => {
    if (!editor) return;
    const nextTheme = next.theme ?? themeRef.current;
    const nextWidth = next.width ?? widthRef.current;
    themeRef.current = nextTheme;
    widthRef.current = nextWidth;
    setTheme(nextTheme);
    setWidth(nextWidth);
    hasLocalEditsRef.current = true;
    onChangeRef.current(createPageSnapshotSource({
      content: editor.getJSON(),
      theme: nextTheme,
      width: nextWidth,
    }));
  }, [editor]);

  const handleFileInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (editor && files.length > 0) void uploadFiles(editor, files);
  }, [editor, uploadFiles]);

  return (
    <div
      className="page-editor-shell"
      data-page-theme={theme}
      data-page-width={width}
    >
      <PageEditorToolbar
        editor={editor}
        onChooseMedia={() => fileInputRef.current?.click()}
        onThemeChange={(nextTheme) => updateDesign({ theme: nextTheme })}
        onWidthChange={(nextWidth) => updateDesign({ width: nextWidth })}
        theme={theme}
        width={width}
      />
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml,video/mp4,video/quicktime,.jpg,.jpeg,.png,.webp,.gif,.avif,.svg,.mp4,.mov"
        onChange={handleFileInput}
        tabIndex={-1}
      />
      <div className="page-editor-surface">
        <EditorContent editor={editor} />
      </div>
      {isDraggingMedia ? (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-4 bottom-8 z-40 mx-auto w-fit rounded-xl border border-dashed border-[var(--ink)] bg-[var(--paper)] px-6 py-4 text-sm text-[var(--ink)] shadow-lg"
        >
          Drop images or videos to add them
        </div>
      ) : null}
    </div>
  );
}
