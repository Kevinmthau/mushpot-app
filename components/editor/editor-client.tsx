"use client";

import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { type Range } from "@codemirror/state";
import { type SyntaxNode } from "@lezer/common";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";

import { putCachedDocument, deleteCachedDocument, type CachedDocument } from "@/lib/doc-cache";
import { formatRelativeTimestamp } from "@/lib/format-relative-time";
import { parseImageWidthTokenFromText } from "@/lib/markdown/image-width";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type EditorDocument = {
  id: string;
  owner: string;
  title: string;
  content: string;
  updated_at: string;
  share_enabled: boolean;
  share_token: string | null;
};

type EditorClientProps = {
  initialDocument: EditorDocument;
};

const IMAGE_BUCKET = "document-images";
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const AUTOSAVE_DEBOUNCE_MS = 800;
const DECORATION_REBUILD_INTERVAL_MS = 120;
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "svg",
]);
const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
];
const SUPPORTED_IMAGE_MIME_TYPE_SET = new Set([
  ...SUPPORTED_IMAGE_MIME_TYPES,
  "image/jpg",
]);
const SUPPORTED_IMAGE_FORMATS_LABEL = SUPPORTED_IMAGE_MIME_TYPES.join(", ");
const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
  },
  ".cm-content": {
    caretColor: "#2f5966",
  },
  ".cm-md-strong": {
    fontWeight: "700",
  },
  ".cm-md-emphasis": {
    fontStyle: "italic",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "#d3e2e0 !important",
  },
});

const ShareModal = dynamic(
  () => import("@/components/editor/share-modal").then((module) => module.ShareModal),
  {
    ssr: false,
  },
);

class HiddenMarkdownMarkWidget extends WidgetType {
  toDOM() {
    const element = document.createElement("span");
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  ignoreEvent() {
    return true;
  }
}

class MarkdownImagePreviewWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly altText: string,
    private readonly width: string | null,
  ) {
    super();
  }

  eq(other: MarkdownImagePreviewWidget) {
    return (
      this.src === other.src &&
      this.altText === other.altText &&
      this.width === other.width
    );
  }

  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-image-preview";
    wrapper.setAttribute("aria-label", this.altText || "Image");

    const image = document.createElement("img");
    image.src = this.src;
    image.alt = this.altText;
    image.loading = "lazy";
    image.decoding = "async";
    image.draggable = false;
    if (this.width) {
      image.style.width = this.width;
    }

    wrapper.appendChild(image);
    return wrapper;
  }
}

const strongDecoration = Decoration.mark({ class: "cm-md-strong" });
const emphasisDecoration = Decoration.mark({ class: "cm-md-emphasis" });
const hiddenMarkdownMarkDecoration = Decoration.replace({
  widget: new HiddenMarkdownMarkWidget(),
});

function getCurrentTimeMs() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function parseMarkdownImage(
  view: EditorView,
  from: number,
  to: number,
  syntaxNode: SyntaxNode,
) {
  let url: string | null = null;
  let closingAltBracketPos: number | null = null;

  for (let child = syntaxNode.firstChild; child; child = child.nextSibling) {
    const childText = view.state.doc.sliceString(child.from, child.to);
    if (child.type.name === "URL") {
      url = childText.trim();
      continue;
    }

    if (child.type.name === "LinkMark" && childText === "]") {
      closingAltBracketPos = child.from;
    }
  }

  if (!url) {
    return null;
  }

  if (url.startsWith("<") && url.endsWith(">")) {
    url = url.slice(1, -1).trim();
  }

  if (!url) {
    return null;
  }

  const altStart = from + 2;
  const altText =
    closingAltBracketPos !== null && closingAltBracketPos >= altStart
      ? view.state.doc.sliceString(altStart, closingAltBracketPos)
      : "";

  const suffix = view.state.doc.sliceString(to, Math.min(view.state.doc.length, to + 64));
  const parsedWidthToken = parseImageWidthTokenFromText(suffix);
  const replaceTo = parsedWidthToken ? to + parsedWidthToken.consumedChars : to;

  return {
    altText: altText || "image",
    replaceTo,
    url,
    width: parsedWidthToken?.width ?? null,
  };
}

function selectionIntersectsRange(view: EditorView, from: number, to: number) {
  return view.state.selection.ranges.some((range) => {
    if (range.from === range.to) {
      return range.from >= from && range.from <= to;
    }

    return range.from < to && range.to > from;
  });
}

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "StrongEmphasis") {
          decorations.push(strongDecoration.range(node.from, node.to));
          return;
        }

        if (node.name === "Emphasis") {
          decorations.push(emphasisDecoration.range(node.from, node.to));
          return;
        }

        if (node.name === "EmphasisMark") {
          decorations.push(hiddenMarkdownMarkDecoration.range(node.from, node.to));
          return;
        }

        if (node.name === "Image") {
          const parsedImage = parseMarkdownImage(view, node.from, node.to, node.node);
          if (!parsedImage) {
            return;
          }

          if (selectionIntersectsRange(view, node.from, parsedImage.replaceTo)) {
            return;
          }

          decorations.push(
            Decoration.replace({
              widget: new MarkdownImagePreviewWidget(
                parsedImage.url,
                parsedImage.altText,
                parsedImage.width,
              ),
            }).range(node.from, parsedImage.replaceTo),
          );
        }
      },
    });
  }

  return Decoration.set(decorations, true);
}

const markdownLiveFormatting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    lastDecorationBuildAt: number;

    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view);
      this.lastDecorationBuildAt = getCurrentTimeMs();
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildMarkdownDecorations(update.view);
        this.lastDecorationBuildAt = getCurrentTimeMs();
        return;
      }

      if (!update.viewportChanged && !update.selectionSet) {
        return;
      }

      const now = getCurrentTimeMs();
      if (now - this.lastDecorationBuildAt < DECORATION_REBUILD_INTERVAL_MS) {
        return;
      }

      this.lastDecorationBuildAt = now;
      this.decorations = buildMarkdownDecorations(update.view);
    }
  },
  {
    decorations: (instance) => instance.decorations,
  },
);

function estimateReadingTime(wordCount: number) {
  if (wordCount === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(wordCount / 225));
}

function sanitizeImageAltText(fileName: string) {
  const withoutExtension = fileName.replace(/\.[^/.]+$/, "");
  const normalized = withoutExtension.replace(/[-_]+/g, " ").trim();
  return normalized || "image";
}

function sanitizeStorageFileName(fileName: string) {
  const normalized = fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const cleaned = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "image";
}

function inferImageMimeType(fileName: string) {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = match?.[1];

  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

function normalizeImageMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpg") {
    return "image/jpeg";
  }

  if (SUPPORTED_IMAGE_MIME_TYPE_SET.has(normalized)) {
    return normalized;
  }

  return null;
}

function isSupportedImageFile(file: File) {
  if (file.type) {
    return normalizeImageMimeType(file.type) !== null;
  }

  const extensionMatch = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = extensionMatch?.[1];
  return extension ? SUPPORTED_IMAGE_EXTENSIONS.has(extension) : false;
}

function buildImageMarkdown(
  view: EditorView,
  position: number,
  altText: string,
  url: string,
) {
  const before = position > 0 ? view.state.doc.sliceString(position - 1, position) : "\n";
  const after =
    position < view.state.doc.length
      ? view.state.doc.sliceString(position, position + 1)
      : "\n";
  const prefix = before === "\n" ? "" : "\n";
  const suffix = after === "\n" ? "\n" : "\n\n";
  return `${prefix}![${altText}](${url})${suffix}`;
}

export function EditorClient({ initialDocument }: EditorClientProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const router = useRouter();

  const [title, setTitle] = useState(initialDocument.title);
  const [content, setContent] = useState(initialDocument.content);
  const [updatedAt, setUpdatedAt] = useState(initialDocument.updated_at);
  const [shareEnabled, setShareEnabled] = useState(initialDocument.share_enabled);
  const [shareToken, setShareToken] = useState(initialDocument.share_token);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [uploadingImagesCount, setUploadingImagesCount] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  const saveTimeoutRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const queuedSaveRef = useRef<{ title: string; content: string } | null>(null);
  const isDeletingRef = useRef(false);
  const didEditSinceHydrationRef = useRef(false);
  const lastSavedRef = useRef({
    title: initialDocument.title,
    content: initialDocument.content,
  });
  const latestDraftRef = useRef({
    title: initialDocument.title,
    content: initialDocument.content,
  });
  const deferredContent = useDeferredValue(content);

  useEffect(() => {
    if (didEditSinceHydrationRef.current) {
      return;
    }

    setTitle(initialDocument.title);
    setContent(initialDocument.content);
    setUpdatedAt(initialDocument.updated_at);
    setShareEnabled(initialDocument.share_enabled);
    setShareToken(initialDocument.share_token);
    lastSavedRef.current = {
      title: initialDocument.title,
      content: initialDocument.content,
    };
    latestDraftRef.current = {
      title: initialDocument.title,
      content: initialDocument.content,
    };
  }, [initialDocument]);

  useEffect(() => {
    latestDraftRef.current = { title, content };
  }, [content, title]);

  // Persist to IndexedDB on every change (instant, no network needed).
  // This makes the next page load instant — the editor reads from cache.
  const localCacheTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    if (localCacheTimeoutRef.current !== null) {
      window.clearTimeout(localCacheTimeoutRef.current);
    }
    // Microtask debounce — 150ms is imperceptible but avoids hammering IDB
    localCacheTimeoutRef.current = window.setTimeout(() => {
      localCacheTimeoutRef.current = null;
      const isDirty =
        title !== lastSavedRef.current.title || content !== lastSavedRef.current.content;
      const doc: CachedDocument = {
        id: initialDocument.id,
        owner: initialDocument.owner,
        title,
        content,
        updated_at: new Date().toISOString(),
        share_enabled: shareEnabled,
        share_token: shareToken,
        _localUpdatedAt: Date.now(),
        _dirty: isDirty,
      };
      putCachedDocument(doc);
    }, 150);
    return () => {
      if (localCacheTimeoutRef.current !== null) {
        window.clearTimeout(localCacheTimeoutRef.current);
      }
    };
  }, [title, content, initialDocument.id, initialDocument.owner, shareEnabled, shareToken]);

  const words = useMemo(() => {
    const trimmed = deferredContent.trim();
    if (!trimmed) {
      return 0;
    }

    return trimmed.split(/\s+/).length;
  }, [deferredContent]);

  const readingTime = useMemo(() => estimateReadingTime(words), [words]);

  const insertUploadedImages = useCallback(
    async (view: EditorView, files: File[], initialInsertPosition: number) => {
      if (files.length === 0) {
        return;
      }

      setUploadingImagesCount((count) => count + files.length);

      let insertPosition = initialInsertPosition;
      const failures: string[] = [];
      try {
        for (const file of files) {
          if (!isSupportedImageFile(file)) {
            failures.push(
              `${file.name || "File"} is not a supported image. Allowed formats: ${SUPPORTED_IMAGE_FORMATS_LABEL}.`,
            );
            continue;
          }

          if (file.size > MAX_IMAGE_SIZE_BYTES) {
            failures.push(`${file.name || "Image"} exceeds the 10MB upload limit.`);
            continue;
          }

          try {
            const safeName = sanitizeStorageFileName(file.name);
            const randomId =
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            const path = `${initialDocument.owner}/${initialDocument.id}/${randomId}-${safeName}`;
            const inferredMimeType = inferImageMimeType(file.name);
            const normalizedMimeType = file.type ? normalizeImageMimeType(file.type) : null;
            const contentType = normalizedMimeType || inferredMimeType || undefined;

            const { error } = await supabase.storage
              .from(IMAGE_BUCKET)
              .upload(path, file, {
                contentType,
                upsert: false,
              });

            if (error) {
              throw error;
            }

            const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
            const markdownImage = buildImageMarkdown(
              view,
              insertPosition,
              sanitizeImageAltText(file.name),
              data.publicUrl,
            );
            const safeInsertPosition = Math.min(insertPosition, view.state.doc.length);
            view.dispatch({
              changes: {
                from: safeInsertPosition,
                to: safeInsertPosition,
                insert: markdownImage,
              },
              selection: {
                anchor: safeInsertPosition + markdownImage.length,
              },
            });
            insertPosition = safeInsertPosition + markdownImage.length;
          } catch (error) {
            console.error("Image upload failed", error);
            failures.push(`Failed to upload ${file.name || "an image"}.`);
          }
        }
      } finally {
        setUploadingImagesCount((count) => Math.max(0, count - files.length));
      }

      if (failures.length > 0) {
        window.alert(failures.join("\n"));
      }
    },
    [initialDocument.id, initialDocument.owner, supabase],
  );

  const imageDropPasteHandlers = useMemo(
    () =>
      EditorView.domEventHandlers({
        dragover: (event) => {
          const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes("Files");
          if (!hasFiles) {
            return false;
          }

          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "copy";
          }
          return true;
        },
        drop: (event, view) => {
          const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
          if (droppedFiles.length === 0) {
            return false;
          }

          event.preventDefault();

          const files = droppedFiles.filter(isSupportedImageFile);
          if (files.length === 0) {
            window.alert(
              `Only image files are supported. Allowed formats: ${SUPPORTED_IMAGE_FORMATS_LABEL}.`,
            );
            return true;
          }

          const dropPosition =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.from;
          void insertUploadedImages(view, files, dropPosition);
          return true;
        },
        paste: (event, view) => {
          const pastedFiles = Array.from(event.clipboardData?.files ?? []);
          if (pastedFiles.length === 0) {
            return false;
          }

          event.preventDefault();

          const files = pastedFiles.filter(isSupportedImageFile);
          if (files.length === 0) {
            window.alert(
              `Only image files are supported. Allowed formats: ${SUPPORTED_IMAGE_FORMATS_LABEL}.`,
            );
            return true;
          }

          void insertUploadedImages(view, files, view.state.selection.main.from);
          return true;
        },
      }),
    [insertUploadedImages],
  );

  const editorExtensions = useMemo(
    () => [
      markdown(),
      markdownLiveFormatting,
      imageDropPasteHandlers,
      placeholder("|..."),
      EditorView.lineWrapping,
      editorTheme,
    ],
    [imageDropPasteHandlers],
  );

  const saveDraft = useCallback(
    async (nextTitle: string, nextContent: string) => {
      if (isDeletingRef.current) {
        return true;
      }

      if (
        nextTitle === lastSavedRef.current.title &&
        nextContent === lastSavedRef.current.content
      ) {
        return true;
      }

      if (saveInFlightRef.current) {
        queuedSaveRef.current = {
          title: nextTitle,
          content: nextContent,
        };
        return true;
      }

      saveInFlightRef.current = true;
      let titleToSave = nextTitle;
      let contentToSave = nextContent;

      try {
        // Save current state and collapse overlapping save requests into one follow-up write.
        while (true) {
          if (isDeletingRef.current) {
            return true;
          }

          const persistedTitle = titleToSave.trim() ? titleToSave : "Untitled";
          const { error } = await supabase
            .from("documents")
            .update({
              title: persistedTitle,
              content: contentToSave,
            })
            .eq("id", initialDocument.id);

          if (error) {
            return false;
          }

          const nextUpdatedAt = new Date().toISOString();
          lastSavedRef.current = {
            title: titleToSave,
            content: contentToSave,
          };
          setUpdatedAt(nextUpdatedAt);
          void putCachedDocument({
            id: initialDocument.id,
            owner: initialDocument.owner,
            title: persistedTitle,
            content: contentToSave,
            updated_at: nextUpdatedAt,
            share_enabled: shareEnabled,
            share_token: shareToken,
            _dirty: false,
            _localUpdatedAt: Date.now(),
          });

          const queuedSave = queuedSaveRef.current;
          if (!queuedSave) {
            return true;
          }

          queuedSaveRef.current = null;
          if (
            queuedSave.title === lastSavedRef.current.title &&
            queuedSave.content === lastSavedRef.current.content
          ) {
            return true;
          }

          titleToSave = queuedSave.title;
          contentToSave = queuedSave.content;
        }
      } finally {
        saveInFlightRef.current = false;
      }
    },
    [initialDocument.id, initialDocument.owner, shareEnabled, shareToken, supabase],
  );

  useEffect(() => {
    const isDirty =
      title !== lastSavedRef.current.title || content !== lastSavedRef.current.content;

    if (!isDirty) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      saveTimeoutRef.current = null;
      void saveDraft(title, content);
    }, AUTOSAVE_DEBOUNCE_MS);
    saveTimeoutRef.current = timeoutId;

    return () => {
      window.clearTimeout(timeoutId);
      if (saveTimeoutRef.current === timeoutId) {
        saveTimeoutRef.current = null;
      }
    };
  }, [content, saveDraft, title]);

  useEffect(() => {
    const flushPendingDraft = () => {
      if (document.visibilityState !== "hidden") {
        return;
      }

      const latestDraft = latestDraftRef.current;
      const isDirty =
        latestDraft.title !== lastSavedRef.current.title ||
        latestDraft.content !== lastSavedRef.current.content;

      if (!isDirty) {
        return;
      }

      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      void saveDraft(latestDraft.title, latestDraft.content);
    };

    document.addEventListener("visibilitychange", flushPendingDraft);
    return () => {
      document.removeEventListener("visibilitychange", flushPendingDraft);
    };
  }, [saveDraft]);

  const handleDeleteDocument = useCallback(async () => {
    if (isDeleting) {
      return;
    }

    const isConfirmed = window.confirm(
      "Delete this document? This action cannot be undone.",
    );
    if (!isConfirmed) {
      return;
    }

    isDeletingRef.current = true;
    setIsDeleting(true);
    setIsShareModalOpen(false);
    queuedSaveRef.current = null;
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", initialDocument.id)
      .eq("owner", initialDocument.owner);

    if (error) {
      isDeletingRef.current = false;
      setIsDeleting(false);
      window.alert(error.message || "Unable to delete document. Please try again.");
      return;
    }

    // Remove from local cache
    deleteCachedDocument(initialDocument.id);

    router.replace("/");
    router.refresh();
  }, [initialDocument.id, initialDocument.owner, isDeleting, router, supabase]);

  const formattedUpdated = useMemo(() => {
    return formatRelativeTimestamp(updatedAt);
  }, [updatedAt]);

  return (
    <div className="min-h-dvh pb-14 sm:pb-20">
      <main className="mx-auto w-full max-w-[800px] px-4 pt-8 sm:px-5 sm:pt-12 md:px-0">
        <input
          value={title}
          onChange={(event) => {
            didEditSinceHydrationRef.current = true;
            const nextTitle = event.target.value;
            setTitle(nextTitle);
          }}
          onBlur={() => {
            if (!title.trim()) {
              const nextTitle = "Untitled";
              setTitle(nextTitle);
            }
          }}
          placeholder="Untitled"
          className="editor-title-input mb-4 w-full border-none bg-transparent p-0 text-[var(--ink)] outline-none"
          aria-label="Document title"
        />

        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
          <span>{readingTime} min read</span>
          <span>•</span>
          <span>{formattedUpdated}</span>
          {uploadingImagesCount > 0 ? (
            <>
              <span>•</span>
              <span>
                Uploading {uploadingImagesCount} image
                {uploadingImagesCount === 1 ? "" : "s"}...
              </span>
            </>
          ) : null}
          <span>•</span>
          <button
            type="button"
            onClick={() => setIsShareModalOpen(true)}
            disabled={isDeleting}
            className="text-xs uppercase tracking-[0.08em] text-[var(--muted)] transition hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            Share
          </button>
          <span>•</span>
          <button
            type="button"
            onClick={() => {
              void handleDeleteDocument();
            }}
            disabled={isDeleting}
            className="text-xs uppercase tracking-[0.08em] text-[var(--muted)] transition hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isDeleting ? "Deleting..." : "DELETE"}
          </button>
        </div>

        <div className="pb-24">
          <CodeMirror
            value={content}
            onChange={(value) => {
              didEditSinceHydrationRef.current = true;
              setContent(value);
            }}
            extensions={editorExtensions}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              dropCursor: false,
              allowMultipleSelections: false,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
            }}
          />
        </div>
      </main>

      {isShareModalOpen ? (
        <ShareModal
          documentId={initialDocument.id}
          isOpen={isShareModalOpen}
          onClose={() => setIsShareModalOpen(false)}
          shareEnabled={shareEnabled}
          shareToken={shareToken}
          onShareUpdated={(enabled, token) => {
            setShareEnabled(enabled);
            setShareToken(token);
            setUpdatedAt(new Date().toISOString());
          }}
        />
      ) : null}
    </div>
  );
}
