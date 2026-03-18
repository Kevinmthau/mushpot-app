"use client";

import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";

import {
  editorTheme,
  markdownLiveFormatting,
} from "@/components/editor/editor-appearance";
import { CodeMirrorEditor } from "@/components/editor/code-mirror-editor";
import { getReadingTimeFromText } from "@/lib/document-stats";
import { formatRelativeTimestamp } from "@/lib/format-relative-time";

type SharedDocumentPageClientProps = {
  content: string;
  documentId: string;
  title: string;
  updatedAt: string;
};

export function SharedDocumentPageClient({
  content,
  documentId,
  title,
  updatedAt,
}: SharedDocumentPageClientProps) {
  const readingTime = useMemo(() => {
    return getReadingTimeFromText(content);
  }, [content]);

  const formattedUpdated = useMemo(() => formatRelativeTimestamp(updatedAt), [updatedAt]);
  const editorExtensions = useMemo(
    () => [markdown(), markdownLiveFormatting, EditorView.lineWrapping, editorTheme],
    [],
  );

  return (
    <div className="min-h-dvh pb-14 sm:pb-20">
      <main className="mx-auto w-full max-w-[800px] px-4 pt-8 sm:px-5 sm:pt-12 md:px-0">
        <h1 className="editor-title-input m-0 mb-4 whitespace-pre-wrap break-words text-[var(--ink)]">
          {title || "Untitled"}
        </h1>

        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
          <span>{readingTime} min read</span>
          <span>•</span>
          <span>{formattedUpdated}</span>
        </div>

        <div className="pb-24">
          <CodeMirrorEditor
            documentId={`shared-${documentId}`}
            initialValue={content}
            extensions={editorExtensions}
            editable={false}
            readOnly={true}
          />
        </div>
      </main>
    </div>
  );
}
