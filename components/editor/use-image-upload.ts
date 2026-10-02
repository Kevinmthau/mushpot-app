"use client";

import { useCallback, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { EditorView, ViewPlugin } from "@codemirror/view";

import {
  buildEmbeddedMediaMarkdown,
  isSupportedMediaFile,
  SUPPORTED_MEDIA_FORMATS_LABEL,
} from "@/components/editor/image-upload-utils";
import { uploadDocumentMedia } from "@/components/editor/media-upload";

type UseMediaUploadInsertionParams = {
  documentId: string;
  dropTargetRef?: RefObject<HTMLElement | null>;
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
  dropTargetRef,
  owner,
}: UseMediaUploadInsertionParams) {
  const scope = useMemo(() => ({
    ...createUploadScope(), documentId, owner,
  }), [documentId, owner]);
  const [uploading, setUploading] = useState({ scope, count: 0 });
  const [dragging, setDragging] = useState({ scope, active: false });

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

  const viewLifecycle = useMemo(() => ViewPlugin.fromClass(class {
    private readonly target: HTMLElement;
    private dragDepth = 0;

    constructor(private readonly view: EditorView) {
      scope.views.add(view);
      this.target = dropTargetRef?.current ?? view.dom;
      // Capture before CodeMirror's content handlers: rendered image/link
      // widgets ignore editor events, and the document surface extends beyond
      // the contenteditable (title, margins, and space below the body).
      this.target.addEventListener("dragenter", this.dragenter, true);
      this.target.addEventListener("dragover", this.dragover, true);
      this.target.addEventListener("dragleave", this.dragleave, true);
      this.target.addEventListener("drop", this.drop, true);
      window.addEventListener("drop", this.resetDrag);
      window.addEventListener("dragend", this.resetDrag);
      window.addEventListener("blur", this.resetDrag);
    }

    private hasFiles = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      return Array.from(transfer?.types ?? []).includes("Files") ||
        Array.from(transfer?.items ?? []).some((item) => item.kind === "file") ||
        (transfer?.files?.length ?? 0) > 0;
    };

    private setDragging = (active: boolean) => {
      if (!scope.lifetime) return;
      setDragging((current) => current.scope === scope && current.active === active
        ? current
        : { scope, active });
    };

    private resetDrag = () => {
      this.dragDepth = 0;
      this.setDragging(false);
    };

    private dragenter = (event: DragEvent) => {
      if (!this.hasFiles(event) || this.view.state.readOnly) return;
      this.dragDepth += 1;
      this.setDragging(true);
    };

    private dragover = (event: DragEvent) => {
      if (!this.hasFiles(event) || this.view.state.readOnly) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      this.setDragging(true);
    };

    private dragleave = () => {
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.setDragging(false);
    };

    private drop = (event: DragEvent) => {
      this.resetDrag();
      const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
      if (!droppedFiles.length || this.view.state.readOnly) return;
      event.preventDefault();
      event.stopPropagation();

      const files = droppedFiles.filter(isSupportedMediaFile);
      if (!files.length) {
        window.alert(
          `Only image and video files are supported. Allowed formats: ${SUPPORTED_MEDIA_FORMATS_LABEL}.`,
        );
        return;
      }

      const bounds = this.view.dom.getBoundingClientRect();
      const dropPosition = event.clientY < bounds.top ? 0
        : event.clientY > bounds.bottom ? this.view.state.doc.length
          : this.view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            this.view.state.selection.main.from;
      this.view.focus();
      void insertUploadedMedia(this.view, files, dropPosition);
    };

    destroy() {
      this.target.removeEventListener("dragenter", this.dragenter, true);
      this.target.removeEventListener("dragover", this.dragover, true);
      this.target.removeEventListener("dragleave", this.dragleave, true);
      this.target.removeEventListener("drop", this.drop, true);
      window.removeEventListener("drop", this.resetDrag);
      window.removeEventListener("dragend", this.resetDrag);
      window.removeEventListener("blur", this.resetDrag);
      this.resetDrag();
      scope.views.delete(this.view);
      for (const job of scope.jobs) {
        if (job.view === this.view) job.controller.abort();
      }
    }
  }), [dropTargetRef, insertUploadedMedia, scope]);

  const mediaUploadExtensions = useMemo(
    () => [
      EditorView.domEventHandlers({
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
    isDraggingMedia: dragging.scope === scope && dragging.active,
    mediaUploadExtensions,
    uploadingMediaCount: uploading.scope === scope ? uploading.count : 0,
  };
}
