"use client";

import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  editorTheme,
  markdownLiveFormatting,
} from "@/components/editor/editor-appearance";
import { CodeMirrorEditor } from "@/components/editor/code-mirror-editor";
import { MissingDocumentFallback } from "@/components/editor/missing-document-fallback";
import type { EditorClientProps } from "@/components/editor/editor-types";
import { useDocumentDraft } from "@/components/editor/use-document-draft";
import { useImageUploadInsertion } from "@/components/editor/use-image-upload";
import { deleteCachedDocument } from "@/lib/doc-cache";
import { getSupabaseBrowserClient } from "@/lib/document-sync";

const ShareModal = dynamic(
  () => import("@/components/editor/share-modal").then((module) => module.ShareModal),
  {
    ssr: false,
  },
);

export function EditorClient(props: EditorClientProps) {
  if (!props?.initialDocument) {
    return <MissingDocumentFallback />;
  }

  return <EditorClientInner initialDocument={props.initialDocument} />;
}

function EditorClientInner({ initialDocument }: EditorClientProps) {
  const router = useRouter();
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const {
    formattedUpdated,
    getLatestContent,
    getLatestTitle,
    handleEditorChange,
    handleTitleBlur,
    handleTitleChange,
    isDeleting,
    markDeleting,
    readingTime,
    resetDeletingState,
    shareEnabled,
    shareToken,
    title,
    updateShareState,
  } = useDocumentDraft(initialDocument);
  const { imageDropPasteHandlers, uploadingImagesCount } = useImageUploadInsertion({
    documentId: initialDocument.id,
    owner: initialDocument.owner,
  });

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

    markDeleting();
    setIsShareModalOpen(false);

    const supabase = await getSupabaseBrowserClient();
    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", initialDocument.id)
      .eq("owner", initialDocument.owner);

    if (error) {
      resetDeletingState();
      window.alert(error.message || "Unable to delete document. Please try again.");
      return;
    }

    void deleteCachedDocument(initialDocument.id);

    router.replace("/");
    router.refresh();
  }, [
    initialDocument.id,
    initialDocument.owner,
    isDeleting,
    markDeleting,
    resetDeletingState,
    router,
  ]);

  return (
    <div className="min-h-dvh pb-14 sm:pb-20">
      <main className="mx-auto w-full max-w-[800px] px-4 pt-8 sm:px-5 sm:pt-12 md:px-0">
        <input
          value={title}
          onChange={(event) => {
            handleTitleChange(event.target.value);
          }}
          onBlur={handleTitleBlur}
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
            onChange={handleEditorChange}
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
          onShareUpdated={updateShareState}
        />
      ) : null}
    </div>
  );
}
