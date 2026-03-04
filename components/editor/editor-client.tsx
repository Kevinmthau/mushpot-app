"use client";

import { markdown } from "@codemirror/lang-markdown";
import { EditorView, placeholder } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { formatDistanceToNow } from "date-fns";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"Saved" | "Saving…" | "Error">(
    "Saved",
  );

  const saveVersionRef = useRef(0);
  const saveTimeoutRef = useRef<number | null>(null);
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

  const saveDraft = useCallback(
    async (nextTitle: string, nextContent: string) => {
      const saveVersion = ++saveVersionRef.current;
      const persistedTitle = nextTitle.trim() ? nextTitle : "Untitled";

      setSaveStatus("Saving…");

      const savePromise = (async () => {
        const { error } = await supabase
          .from("documents")
          .update({
            title: persistedTitle,
            content: nextContent,
            updated_at: new Date().toISOString(),
          })
          .eq("id", initialDocument.id);

        if (saveVersion !== saveVersionRef.current) {
          return true;
        }

        if (error) {
          setSaveStatus("Error");
          return false;
        }

        lastSavedRef.current = {
          title: nextTitle,
          content: nextContent,
        };
        const now = new Date().toISOString();
        setUpdatedAt(now);
        setSaveStatus("Saved");
        return true;
      })();

      const didSave = await savePromise;
      return didSave;
    },
    [initialDocument.id, supabase],
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
    }, 500);
    saveTimeoutRef.current = timeoutId;

    return () => {
      window.clearTimeout(timeoutId);
      if (saveTimeoutRef.current === timeoutId) {
        saveTimeoutRef.current = null;
      }
    };
  }, [content, saveDraft, title]);

  const formattedUpdated = formatDistanceToNow(new Date(updatedAt), {
    addSuffix: true,
  });

  return (
    <div className="min-h-screen pb-20">
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
          className="editor-title-input mb-4 w-full border-none bg-transparent p-0 text-[var(--ink)] outline-none"
          aria-label="Document title"
        />

        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
          <span>{words} words</span>
          <span>•</span>
          <span>{readingTime} min read</span>
          <span>•</span>
          <span className={saveStatus === "Error" ? "text-[#9b2d34]" : ""}>
            {saveStatus}
          </span>
          <span>•</span>
          <span>Updated {formattedUpdated}</span>
          <span>•</span>
          <button
            type="button"
            onClick={() => setIsShareModalOpen(true)}
            className="text-xs uppercase tracking-[0.08em] text-[var(--muted)] transition hover:text-[var(--ink)]"
          >
            Share
          </button>
        </div>

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
      </main>

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
    </div>
  );
}
