"use client";

import dynamic from "next/dynamic";
import { type Text } from "@codemirror/state";
import Link from "next/link";
import type { ComponentType, MouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useDocumentClone } from "@/components/editor/use-document-clone";
import { useDocumentDelete } from "@/components/editor/use-document-delete";
import { MissingDocumentFallback } from "@/components/editor/missing-document-fallback";
import type { EditorClientProps } from "@/components/editor/editor-types";
import { useDocumentDraft } from "@/components/editor/use-document-draft";
import { consumeNewDocumentTitleFocus } from "@/lib/new-document-focus";

const ShareModal = dynamic(
  () => import("@/components/editor/share-modal").then((module) => module.ShareModal),
  {
    ssr: false,
  },
);

type EditorWorkspaceProps = {
  documentId: string;
  initialValue: string;
  onChange: (doc: Text) => void;
  onUploadingImagesCountChange?: (count: number) => void;
  owner: string;
  placeholder?: string;
};

let editorWorkspaceModulePromise:
  | Promise<typeof import("@/components/editor/editor-workspace")>
  | null = null;
let resolvedEditorWorkspace: ComponentType<EditorWorkspaceProps> | null = null;

export function preloadEditorWorkspace() {
  if (!editorWorkspaceModulePromise) {
    editorWorkspaceModulePromise = import("@/components/editor/editor-workspace")
      .then((module) => {
        resolvedEditorWorkspace = module.EditorWorkspace;
        return module;
      })
      .catch((error) => {
        editorWorkspaceModulePromise = null;
        throw error;
      });
  }

  return editorWorkspaceModulePromise;
}

export function EditorClient(props: EditorClientProps) {
  if (!props?.initialDocument) {
    return <MissingDocumentFallback />;
  }

  return <EditorClientInner initialDocument={props.initialDocument} />;
}

function EditorClientInner({ initialDocument }: EditorClientProps) {
  const router = useRouter();
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [uploadingImagesCount, setUploadingImagesCount] = useState(0);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const {
    formattedUpdated,
    flushLatestDraft,
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
  const { isCloning, handleClone } = useDocumentClone({
    documentId: initialDocument.id,
    owner: initialDocument.owner,
    getLatestTitle: getLatestTitle,
    getLatestContent: getLatestContent,
  });
  const handleDeleteDocument = useDocumentDelete({
    documentId: initialDocument.id,
    owner: initialDocument.owner,
    isDeleting,
    onDeleteStart: () => {
      markDeleting();
      setIsShareModalOpen(false);
    },
    onDeleteError: resetDeletingState,
  });

  useEffect(() => {
    router.prefetch("/");
  }, [router]);

  useEffect(() => {
    if (!consumeNewDocumentTitleFocus(initialDocument.id)) {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      const input = titleInputRef.current;

      if (!input) {
        return;
      }

      input.focus();
      input.select();
      input.setSelectionRange(0, input.value.length);
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [initialDocument.id]);

  const handleDocumentsClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (isDeleting) {
        event.preventDefault();
        return;
      }

      flushLatestDraft();
    },
    [flushLatestDraft, isDeleting],
  );

  return (
    <div className="min-h-dvh pb-14 sm:pb-20">
      <main className="mx-auto w-full max-w-[800px] px-4 pt-8 sm:px-5 sm:pt-12 md:px-0">
        <input
          ref={titleInputRef}
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
          <Link
            href="/"
            prefetch={false}
            onClick={handleDocumentsClick}
            aria-label="Back to documents"
            title="Back to documents"
            className="-mx-1 -my-1 px-1 py-1 text-xs uppercase tracking-[0.08em] text-[var(--muted)] transition hover:text-[var(--ink)]"
          >
            {readingTime} min
          </Link>
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
              void handleClone();
            }}
            disabled={isCloning || isDeleting}
            className="text-xs uppercase tracking-[0.08em] text-[var(--muted)] transition hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isCloning ? "Cloning..." : "Clone"}
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
          <EditorWorkspaceLoader
            key={initialDocument.id}
            documentId={initialDocument.id}
            initialValue={initialDocument.content}
            onChange={handleEditorChange}
            onUploadingImagesCountChange={setUploadingImagesCount}
            owner={initialDocument.owner}
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

function EditorWorkspaceFallback({ initialValue }: Pick<EditorWorkspaceProps, "initialValue">) {
  const previewContent = initialValue.trim();

  if (!previewContent) {
    return (
      <div className="space-y-3">
        <div className="h-4 w-full animate-pulse rounded bg-[var(--line)]" />
        <div className="h-4 w-5/6 animate-pulse rounded bg-[var(--line)]" />
        <div className="h-4 w-4/6 animate-pulse rounded bg-[var(--line)]" />
        <div className="h-4 w-full animate-pulse rounded bg-[var(--line)]" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--line)]" />
      </div>
    );
  }

  return (
    <div className="max-h-[60vh] overflow-hidden whitespace-pre-wrap break-words font-[var(--font-writing)] text-[var(--doc-title-size-mobile)] leading-[1.75] text-[var(--ink)]">
      {previewContent}
    </div>
  );
}

function EditorWorkspaceLoader(props: EditorWorkspaceProps) {
  const [LoadedWorkspace, setLoadedWorkspace] = useState<ComponentType<EditorWorkspaceProps> | null>(
    () => resolvedEditorWorkspace,
  );

  useEffect(() => {
    if (LoadedWorkspace) {
      return;
    }

    let isActive = true;

    void preloadEditorWorkspace()
      .then((module) => {
        if (isActive) {
          setLoadedWorkspace(() => module.EditorWorkspace);
        }
      })
      .catch(() => {
        // Leave the lightweight fallback in place if the editor workspace chunk fails.
      });

    return () => {
      isActive = false;
    };
  }, [LoadedWorkspace]);

  if (!LoadedWorkspace) {
    return <EditorWorkspaceFallback initialValue={props.initialValue} />;
  }

  return <LoadedWorkspace {...props} />;
}
