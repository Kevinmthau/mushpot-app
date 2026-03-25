"use client";

import type { ComponentType } from "react";
import { useEffect, useState } from "react";

import { MissingDocumentFallback } from "@/components/editor/missing-document-fallback";
import type { EditorClientProps } from "@/components/editor/editor-types";

let editorClientModulePromise:
  | Promise<typeof import("@/components/editor/editor-client")>
  | null = null;
let resolvedEditorClient: ComponentType<EditorClientProps> | null = null;

export function preloadEditorClient() {
  if (!editorClientModulePromise) {
    editorClientModulePromise = import("@/components/editor/editor-client")
      .then((module) => {
        resolvedEditorClient = module.EditorClient;
        void module.preloadEditorWorkspace?.();
        return module;
      })
      .catch((error) => {
        editorClientModulePromise = null;
        throw error;
      });
  }

  return editorClientModulePromise;
}

function EditorSkeleton({ initialDocument }: Partial<EditorClientProps>) {
  if (!initialDocument) {
    return <MissingDocumentFallback />;
  }

  const previewContent = initialDocument.content.trim();

  return (
    <div className="min-h-dvh pb-14 sm:pb-20">
      <main className="mx-auto w-full max-w-[800px] px-4 pt-8 sm:px-5 sm:pt-12 md:px-0">
        <h1 className="editor-title-input mb-4 text-[var(--ink)]">
          {initialDocument.title || "Untitled"}
        </h1>
        <p className="mb-4 text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
          Opening editor...
        </p>

        {previewContent ? (
          <div className="max-h-[60vh] overflow-hidden whitespace-pre-wrap break-words font-[var(--font-writing)] text-[var(--doc-title-size-mobile)] leading-[1.75] text-[var(--ink)]">
            {previewContent}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="h-4 w-full animate-pulse rounded bg-[var(--line)]" />
            <div className="h-4 w-5/6 animate-pulse rounded bg-[var(--line)]" />
            <div className="h-4 w-4/6 animate-pulse rounded bg-[var(--line)]" />
            <div className="h-4 w-full animate-pulse rounded bg-[var(--line)]" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--line)]" />
          </div>
        )}
      </main>
    </div>
  );
}

export function EditorClient(props: EditorClientProps) {
  if (!props?.initialDocument) {
    return <MissingDocumentFallback />;
  }

  return <EditorClientLoader initialDocument={props.initialDocument} />;
}

function EditorClientLoader(props: EditorClientProps) {
  const [LoadedEditor, setLoadedEditor] = useState<ComponentType<EditorClientProps> | null>(
    () => resolvedEditorClient,
  );

  useEffect(() => {
    if (LoadedEditor) {
      return;
    }

    let isActive = true;

    void preloadEditorClient()
      .then((module) => {
        if (isActive) {
          setLoadedEditor(() => module.EditorClient);
        }
      })
      .catch(() => {
        // Leave the lightweight fallback in place if the editor chunk fails.
      });

    return () => {
      isActive = false;
    };
  }, [LoadedEditor]);

  if (!LoadedEditor) {
    return <EditorSkeleton {...props} />;
  }

  return <LoadedEditor key={props.initialDocument.id} {...props} />;
}
