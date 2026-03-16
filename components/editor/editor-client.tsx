"use client";

import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { type Range, type Text } from "@codemirror/state";
import { type SyntaxNode } from "@lezer/common";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";

import { CodeMirrorEditor } from "@/components/editor/code-mirror-editor";
import { putCachedDocument, deleteCachedDocument, type CachedDocument } from "@/lib/doc-cache";
import {
  getSupabaseBrowserClient,
  persistDocumentSnapshot,
} from "@/lib/document-sync";
import { formatRelativeTimestamp } from "@/lib/format-relative-time";
import { parseImageWidthTokenFromText } from "@/lib/markdown/image-width";

export type EditorDocument = {
  id: string;
  owner: string;
  title: string;
  content: string;
  updated_at: string;
  share_enabled: boolean;
  share_token: string | null;
};

export type EditorClientProps = {
  initialDocument: EditorDocument;
};

function MissingDocumentFallback() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-[800px] px-4 py-12 sm:px-5">
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-5 py-6">
        <h1 className="font-[var(--font-writing)] text-2xl text-[var(--ink)]">
          Unable to open document
        </h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          This page data is out of date. Refresh to load the latest version.
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
          className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white"
        >
          Refresh
        </button>
      </div>
    </main>
  );
}

const IMAGE_BUCKET = "document-images";
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const AUTOSAVE_DEBOUNCE_MS = 800;
const LOCAL_CACHE_DEBOUNCE_MS = 400;
const STATS_SYNC_DEBOUNCE_MS = 250;
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

function readDocumentText(doc: Text | string) {
  return typeof doc === "string" ? doc : doc.toString();
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

export function EditorClient(props: EditorClientProps) {
  if (!props?.initialDocument) {
    return <MissingDocumentFallback />;
  }

  return <EditorClientInner initialDocument={props.initialDocument} />;
}

function EditorClientInner({ initialDocument }: EditorClientProps) {
  const router = useRouter();

  const [title, setTitle] = useState(initialDocument.title);
  const [contentForStats, setContentForStats] = useState(initialDocument.content);
  const [updatedAt, setUpdatedAt] = useState(initialDocument.updated_at);
  const [shareEnabled, setShareEnabled] = useState(initialDocument.share_enabled);
  const [shareToken, setShareToken] = useState(initialDocument.share_token);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [uploadingImagesCount, setUploadingImagesCount] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  const saveTimeoutRef = useRef<number | null>(null);
  const localCacheTimeoutRef = useRef<number | null>(null);
  const statsSyncTimeoutRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const queuedSaveRef = useRef<{ title: string; content: string } | null>(null);
  const isDeletingRef = useRef(false);
  const didEditSinceHydrationRef = useRef(false);
  const latestTitleRef = useRef(initialDocument.title);
  const latestContentRef = useRef<Text | string>(initialDocument.content);
  const shareEnabledRef = useRef(initialDocument.share_enabled);
  const shareTokenRef = useRef(initialDocument.share_token);
  const lastSavedRef = useRef({
    title: initialDocument.title,
    content: initialDocument.content,
  });
  const deferredContent = useDeferredValue(contentForStats);

  useEffect(() => {
    if (didEditSinceHydrationRef.current) {
      return;
    }

    setTitle(initialDocument.title);
    setContentForStats(initialDocument.content);
    setUpdatedAt(initialDocument.updated_at);
    setShareEnabled(initialDocument.share_enabled);
    setShareToken(initialDocument.share_token);
    latestTitleRef.current = initialDocument.title;
    latestContentRef.current = initialDocument.content;
    shareEnabledRef.current = initialDocument.share_enabled;
    shareTokenRef.current = initialDocument.share_token;
    lastSavedRef.current = {
      title: initialDocument.title,
      content: initialDocument.content,
    };
  }, [initialDocument]);

  useEffect(() => {
    latestTitleRef.current = title;
  }, [title]);

  useEffect(() => {
    shareEnabledRef.current = shareEnabled;
    shareTokenRef.current = shareToken;
  }, [shareEnabled, shareToken]);

  const getLatestContent = useCallback(() => {
    return readDocumentText(latestContentRef.current);
  }, []);

  const getLatestTitle = useCallback(() => {
    return latestTitleRef.current;
  }, []);

  const scheduleStatsSync = useCallback(() => {
    if (statsSyncTimeoutRef.current !== null) {
      window.clearTimeout(statsSyncTimeoutRef.current);
    }

    statsSyncTimeoutRef.current = window.setTimeout(() => {
      statsSyncTimeoutRef.current = null;
      const nextContent = getLatestContent();
      startTransition(() => {
        setContentForStats((currentContent) =>
          currentContent === nextContent ? currentContent : nextContent,
        );
      });
    }, STATS_SYNC_DEBOUNCE_MS);
  }, [getLatestContent]);

  const scheduleLocalCacheWrite = useCallback(() => {
    if (localCacheTimeoutRef.current !== null) {
      window.clearTimeout(localCacheTimeoutRef.current);
    }

    localCacheTimeoutRef.current = window.setTimeout(() => {
      localCacheTimeoutRef.current = null;

      if (isDeletingRef.current) {
        return;
      }

      const latestContent = getLatestContent();
      const latestTitle = latestTitleRef.current;
      const isDirty =
        latestTitle !== lastSavedRef.current.title ||
        latestContent !== lastSavedRef.current.content;
      const doc: CachedDocument = {
        id: initialDocument.id,
        owner: initialDocument.owner,
        title: latestTitle,
        content: latestContent,
        updated_at: new Date().toISOString(),
        share_enabled: shareEnabledRef.current,
        share_token: shareTokenRef.current,
        _localUpdatedAt: Date.now(),
        _dirty: isDirty,
      };
      void putCachedDocument(doc);
    }, LOCAL_CACHE_DEBOUNCE_MS);
  }, [getLatestContent, initialDocument.id, initialDocument.owner]);

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
            const supabase = await getSupabaseBrowserClient();
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
    [initialDocument.id, initialDocument.owner],
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

          const result = await persistDocumentSnapshot({
            id: initialDocument.id,
            owner: initialDocument.owner,
            title: titleToSave,
            content: contentToSave,
            share_enabled: shareEnabledRef.current,
            share_token: shareTokenRef.current,
          });

          if (!result.ok || !result.updatedAt) {
            return false;
          }

          lastSavedRef.current = {
            title: titleToSave,
            content: contentToSave,
          };
          setUpdatedAt(result.updatedAt);

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
    [initialDocument.id, initialDocument.owner],
  );

  useEffect(() => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = null;
      void saveDraft(latestTitleRef.current, getLatestContent());
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [getLatestContent, saveDraft, title]);

  useEffect(() => {
    scheduleLocalCacheWrite();
  }, [scheduleLocalCacheWrite, title, shareEnabled, shareToken]);

  useEffect(() => {
    const flushPendingDraft = () => {
      if (document.visibilityState !== "hidden") {
        return;
      }

      const latestTitle = latestTitleRef.current;
      const latestContent = getLatestContent();
      const isDirty =
        latestTitle !== lastSavedRef.current.title ||
        latestContent !== lastSavedRef.current.content;

      if (!isDirty) {
        return;
      }

      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      void saveDraft(latestTitle, latestContent);
    };

    document.addEventListener("visibilitychange", flushPendingDraft);
    return () => {
      document.removeEventListener("visibilitychange", flushPendingDraft);
    };
  }, [getLatestContent, saveDraft]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
      }
      if (localCacheTimeoutRef.current !== null) {
        window.clearTimeout(localCacheTimeoutRef.current);
      }
      if (statsSyncTimeoutRef.current !== null) {
        window.clearTimeout(statsSyncTimeoutRef.current);
      }
    };
  }, []);

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
    if (localCacheTimeoutRef.current !== null) {
      window.clearTimeout(localCacheTimeoutRef.current);
      localCacheTimeoutRef.current = null;
    }
    if (statsSyncTimeoutRef.current !== null) {
      window.clearTimeout(statsSyncTimeoutRef.current);
      statsSyncTimeoutRef.current = null;
    }

    const supabase = await getSupabaseBrowserClient();
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
    void deleteCachedDocument(initialDocument.id);

    router.replace("/");
    router.refresh();
  }, [initialDocument.id, initialDocument.owner, isDeleting, router]);

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
          <CodeMirrorEditor
            documentId={initialDocument.id}
            initialValue={initialDocument.content}
            onChange={(doc) => {
              didEditSinceHydrationRef.current = true;
              latestContentRef.current = doc;
              scheduleStatsSync();
              scheduleLocalCacheWrite();
              if (saveTimeoutRef.current !== null) {
                window.clearTimeout(saveTimeoutRef.current);
              }
              saveTimeoutRef.current = window.setTimeout(() => {
                saveTimeoutRef.current = null;
                void saveDraft(latestTitleRef.current, getLatestContent());
              }, AUTOSAVE_DEBOUNCE_MS);
            }}
            extensions={editorExtensions}
            placeholder="|..."
          />
        </div>
      </main>

      {isShareModalOpen ? (
        <ShareModal
          documentId={initialDocument.id}
          getDocumentText={getLatestContent}
          getDocumentTitle={getLatestTitle}
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
