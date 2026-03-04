"use client";

import { markdown } from "@codemirror/lang-markdown";
import { EditorView, placeholder } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import clsx from "clsx";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useMemo, useRef, useState } from "react";

import { ShareModal } from "@/components/editor/share-modal";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type EditorDocument = {
  id: string;
  title: string;
  content: string;
  updated_at: string;
  share_enabled: boolean;
  share_token: string | null;
};

type EditorClientProps = {
  initialDocument: EditorDocument;
};

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
  },
  ".cm-content": {
    caretColor: "#2f5966",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "#d3e2e0 !important",
  },
});

function estimateReadingTime(wordCount: number) {
  if (wordCount === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(wordCount / 225));
}

export function EditorClient({ initialDocument }: EditorClientProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [title, setTitle] = useState(initialDocument.title);
  const [content, setContent] = useState(initialDocument.content);
  const [updatedAt, setUpdatedAt] = useState(initialDocument.updated_at);
  const [shareEnabled, setShareEnabled] = useState(initialDocument.share_enabled);
  const [shareToken, setShareToken] = useState(initialDocument.share_token);
  const [focusMode, setFocusMode] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"Saved" | "Saving…" | "Error">(
    "Saved",
  );

  const saveVersionRef = useRef(0);
  const lastSavedRef = useRef({
    title: initialDocument.title,
    content: initialDocument.content,
  });

  const words = useMemo(() => {
    const trimmed = content.trim();
    if (!trimmed) {
      return 0;
    }

    return trimmed.split(/\s+/).length;
  }, [content]);

  const readingTime = useMemo(() => estimateReadingTime(words), [words]);

  const editorExtensions = useMemo(
    () => [
      markdown(),
      placeholder("Start writing on the infinite canvas..."),
      EditorView.lineWrapping,
      editorTheme,
    ],
    [],
  );

  const updateSaveStatusForDraft = (nextTitle: string, nextContent: string) => {
    const isDirty =
      nextTitle !== lastSavedRef.current.title ||
      nextContent !== lastSavedRef.current.content;
    setSaveStatus(isDirty ? "Saving…" : "Saved");
  };

  useEffect(() => {
    const isDirty =
      title !== lastSavedRef.current.title || content !== lastSavedRef.current.content;

    if (!isDirty) {
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      const saveVersion = ++saveVersionRef.current;
      const nextTitle = title.trim() ? title : "Untitled";

      const { error } = await supabase
        .from("documents")
        .update({
          title: nextTitle,
          content,
          updated_at: new Date().toISOString(),
        })
        .eq("id", initialDocument.id);

      if (saveVersion !== saveVersionRef.current) {
        return;
      }

      if (error) {
        setSaveStatus("Error");
        return;
      }

      lastSavedRef.current = {
        title,
        content,
      };
      const now = new Date().toISOString();
      setUpdatedAt(now);
      setSaveStatus("Saved");
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [content, initialDocument.id, supabase, title]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && focusMode) {
        setFocusMode(false);
      }
    };

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [focusMode]);

  const formattedUpdated = formatDistanceToNow(new Date(updatedAt), {
    addSuffix: true,
  });

  return (
    <div className="min-h-screen pb-20">
      {!focusMode ? (
        <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-white">
          <div className="mx-auto flex w-full max-w-[980px] items-center justify-between gap-3 px-4 py-3 md:px-6">
            <Link
              href="/"
              className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] transition hover:bg-[rgba(47,89,102,0.09)] hover:text-[var(--accent)]"
            >
              Documents
            </Link>

            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <span className={saveStatus === "Error" ? "text-[#9b2d34]" : ""}>
                {saveStatus}
              </span>
              <span>•</span>
              <span>Updated {formattedUpdated}</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPreviewMode((value) => !value)}
                className={clsx(
                  "rounded-lg border px-3 py-1.5 text-xs transition",
                  previewMode
                    ? "border-[var(--accent)] bg-[rgba(47,89,102,0.09)] text-[var(--accent)]"
                    : "border-[var(--line)] bg-white text-[var(--muted)]",
                )}
              >
                {previewMode ? "Write" : "Preview"}
              </button>

              <button
                type="button"
                onClick={() => setFocusMode((value) => !value)}
                className={clsx(
                  "rounded-lg border px-3 py-1.5 text-xs transition",
                  focusMode
                    ? "border-[var(--accent)] bg-[rgba(47,89,102,0.09)] text-[var(--accent)]"
                    : "border-[var(--line)] bg-white text-[var(--muted)]",
                )}
              >
                Focus
              </button>

              <button
                type="button"
                onClick={() => setIsShareOpen(true)}
                className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                Share
              </button>
            </div>
          </div>
        </header>
      ) : null}

      <main className="mx-auto w-full max-w-[800px] px-5 pt-10 md:px-0">
        <input
          value={title}
          onChange={(event) => {
            const nextTitle = event.target.value;
            setTitle(nextTitle);
            updateSaveStatusForDraft(nextTitle, content);
          }}
          onBlur={() => {
            if (!title.trim()) {
              const nextTitle = "Untitled";
              setTitle(nextTitle);
              updateSaveStatusForDraft(nextTitle, content);
            }
          }}
          placeholder="Untitled"
          className="mb-4 w-full border-none bg-transparent p-0 font-[var(--font-writing)] text-4xl font-semibold tracking-tight text-[var(--ink)] outline-none"
          aria-label="Document title"
        />

        <div className="mb-8 flex items-center gap-2 text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
          <span>{words} words</span>
          <span>•</span>
          <span>{readingTime} min read</span>
          {focusMode ? (
            <>
              <span>•</span>
              <span>{saveStatus}</span>
            </>
          ) : null}
        </div>

        {previewMode ? (
          <article className="markdown-body pb-24">
            <Markdown remarkPlugins={[remarkGfm]}>
              {content || "_Nothing yet. Switch to Write to start._"}
            </Markdown>
          </article>
        ) : (
          <div className="pb-24">
            <CodeMirror
              value={content}
              onChange={(value) => {
                setContent(value);
                updateSaveStatusForDraft(title, value);
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
        )}
      </main>

      {focusMode ? (
        <div className="fixed right-4 top-4 z-30 flex items-center gap-2 rounded-lg border border-[var(--line)] bg-white p-2">
          <button
            type="button"
            onClick={() => setPreviewMode((value) => !value)}
            className="rounded-md px-2 py-1 text-xs text-[var(--muted)] transition hover:bg-[rgba(47,89,102,0.09)]"
          >
            {previewMode ? "Write" : "Preview"}
          </button>
          <button
            type="button"
            onClick={() => setFocusMode(false)}
            className="rounded-md bg-[var(--accent)] px-2 py-1 text-xs text-white"
          >
            Exit focus
          </button>
        </div>
      ) : null}

      <ShareModal
        documentId={initialDocument.id}
        isOpen={isShareOpen}
        onClose={() => setIsShareOpen(false)}
        shareEnabled={shareEnabled}
        shareToken={shareToken}
        onShareUpdated={(enabled, token) => {
          setShareEnabled(enabled);
          setShareToken(token);
        }}
      />
    </div>
  );
}
