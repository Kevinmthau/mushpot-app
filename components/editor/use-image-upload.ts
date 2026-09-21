"use client";

import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { EditorView, ViewPlugin } from "@codemirror/view";

import {
  buildEmbeddedMediaMarkdown,
  isSupportedMediaFile,
  SUPPORTED_MEDIA_FORMATS_LABEL,
} from "@/components/editor/image-upload-utils";
import { uploadDocumentMedia } from "@/components/editor/media-upload";

type UseMediaUploadInsertionParams = {
  documentId: string;
  owner: string;
};

type UploadInsertion = {
  controller: AbortController;
  pos: number;
  view: EditorView;
};

function createUploadScope() {
  return {
    lifetime: null as object | null,
    jobs: new Set<UploadInsertion>(),
    views: new Set<EditorView>(),
  };
}

export function useMediaUploadInsertion({
  documentId,
  owner,
}: UseMediaUploadInsertionParams) {
  const scope = useMemo(() => ({
    ...createUploadScope(), documentId, owner,
  }), [documentId, owner]);
  const [uploading, setUploading] = useState({ scope, count: 0 });

  useLayoutEffect(() => {
    // Every setup gets a new lifetime, including React StrictMode's replay.
    // An old completion cannot become current again after cleanup.
    scope.lifetime = {};
    return () => {
      scope.lifetime = null;
      for (const job of scope.jobs) job.controller.abort();
      scope.jobs.clear();
    };
  }, [scope]);

  const viewLifecycle = useMemo(() => ViewPlugin.fromClass(class {
    constructor(private readonly view: EditorView) {
      scope.views.add(view);
    }

    destroy() {
      scope.views.delete(this.view);
      for (const job of scope.jobs) {
        if (job.view === this.view) job.controller.abort();
      }
    }
  }), [scope]);

  const insertPositionTracker = useMemo(
    () => EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      for (const job of scope.jobs) {
        if (job.view === update.view) {
          job.pos = update.changes.mapPos(job.pos, 1);
        }
      }
    }),
    [scope],
  );

  const insertUploadedMedia = useCallback(
    async (view: EditorView, files: File[], initialInsertPosition: number) => {
      const lifetime = scope.lifetime;
      if (!files.length || !lifetime || !scope.views.has(view)) return;

      const job = { controller: new AbortController(), pos: initialInsertPosition, view };
      const { signal } = job.controller;
      const isCurrent = () => !signal.aborted && scope.lifetime === lifetime;
      scope.jobs.add(job);
      setUploading((current) => ({
        scope,
        count: (current.scope === scope ? current.count : 0) + files.length,
      }));
      const failures: string[] = [];
      try {
        for (const file of files) {
          if (!isCurrent()) return;
          const result = await uploadDocumentMedia({ documentId, owner, file, signal });
          if (!isCurrent() || result.status === "cancelled") return;
          if (result.status === "failed") {
            failures.push(result.message);
            continue;
          }

          const insertPosition = job.pos;
          const markdownMedia = buildEmbeddedMediaMarkdown(
            view, insertPosition, result.media.altText, result.media.url,
            result.media.posterTitle,
          );
          view.dispatch({
            changes: { from: insertPosition, to: insertPosition, insert: markdownMedia },
            selection: { anchor: insertPosition + markdownMedia.length },
          });
        }
      } finally {
        scope.jobs.delete(job);
        if (scope.lifetime === lifetime) {
          setUploading((current) => current.scope === scope
            ? { scope, count: Math.max(0, current.count - files.length) }
            : current);
        }
      }

      if (isCurrent() && failures.length > 0) {
        window.alert(failures.join("\n"));
      }
    },
    [documentId, owner, scope],
  );

  const mediaUploadExtensions = useMemo(
    () => [
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

          const files = droppedFiles.filter(isSupportedMediaFile);
          if (files.length === 0) {
            window.alert(
              `Only image and video files are supported. Allowed formats: ${SUPPORTED_MEDIA_FORMATS_LABEL}.`,
            );
            return true;
          }

          const dropPosition =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.from;
          void insertUploadedMedia(view, files, dropPosition);
          return true;
        },
        paste: (event, view) => {
          const pastedFiles = Array.from(event.clipboardData?.files ?? []);
          if (pastedFiles.length === 0) {
            return false;
          }

          event.preventDefault();

          const files = pastedFiles.filter(isSupportedMediaFile);
          if (files.length === 0) {
            window.alert(
              `Only image and video files are supported. Allowed formats: ${SUPPORTED_MEDIA_FORMATS_LABEL}.`,
            );
            return true;
          }

          void insertUploadedMedia(view, files, view.state.selection.main.from);
          return true;
        },
      }),
      insertPositionTracker,
      viewLifecycle,
    ],
    [insertPositionTracker, insertUploadedMedia, viewLifecycle],
  );

  return {
    mediaUploadExtensions,
    uploadingMediaCount: uploading.scope === scope ? uploading.count : 0,
  };
}
