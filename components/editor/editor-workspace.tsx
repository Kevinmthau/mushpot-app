"use client";

import { markdown } from "@codemirror/lang-markdown";
import { type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo } from "react";

import {
  editorTheme,
  markdownLiveFormatting,
} from "@/components/editor/editor-appearance";
import { CodeMirrorEditor } from "@/components/editor/code-mirror-editor";
import { useImageUploadInsertion } from "@/components/editor/use-image-upload";

type EditorWorkspaceProps = {
  documentId: string;
  initialValue: string;
  onChange: (doc: Text) => void;
  onUploadingImagesCountChange?: (count: number) => void;
  owner: string;
  placeholder?: string;
};

export function EditorWorkspace({
  documentId,
  initialValue,
  onChange,
  onUploadingImagesCountChange,
  owner,
  placeholder,
}: EditorWorkspaceProps) {
  const { imageDropPasteHandlers, uploadingImagesCount } = useImageUploadInsertion({
    documentId,
    owner,
  });

  useEffect(() => {
    onUploadingImagesCountChange?.(uploadingImagesCount);
  }, [onUploadingImagesCountChange, uploadingImagesCount]);

  useEffect(() => {
    return () => {
      onUploadingImagesCountChange?.(0);
    };
  }, [onUploadingImagesCountChange]);

  const editorExtensions = useMemo(
    () => [
      markdown(),
      markdownLiveFormatting,
      imageDropPasteHandlers,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ autocapitalize: "sentences" }),
      editorTheme,
    ],
    [imageDropPasteHandlers],
  );

  return (
    <CodeMirrorEditor
      documentId={documentId}
      initialValue={initialValue}
      onChange={onChange}
      extensions={editorExtensions}
      placeholder={placeholder}
    />
  );
}
