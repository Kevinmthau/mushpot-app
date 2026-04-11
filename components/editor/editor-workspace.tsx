"use client";

import { markdown } from "@codemirror/lang-markdown";
import { type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo } from "react";

import {
  editorTheme,
  markdownLiveFormatting,
} from "@/components/editor/editor-appearance";
import {
  CodeMirrorEditor,
  type CodeMirrorEditorApi,
} from "@/components/editor/code-mirror-editor";
import { useImageUploadInsertion } from "@/components/editor/use-image-upload";

export type EditorWorkspaceApi = CodeMirrorEditorApi;

type EditorWorkspaceProps = {
  documentId: string;
  initialValue: string;
  onChange: (doc: Text) => void;
  onReady?: (api: EditorWorkspaceApi | null) => void;
  onUploadingImagesCountChange?: (count: number) => void;
  owner: string;
  placeholder?: string;
};

// Ensure iOS shows the auto-capitalized shift state at the start of a new
// sentence when the user moves into the body. CodeMirror's contentEditable
// doesn't inherit the attribute from surrounding markup, so set it
// explicitly via contentAttributes.
const editorContentAttributes = EditorView.contentAttributes.of({
  autocapitalize: "sentences",
});

export function EditorWorkspace({
  documentId,
  initialValue,
  onChange,
  onReady,
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
      editorContentAttributes,
      editorTheme,
    ],
    [imageDropPasteHandlers],
  );

  return (
    <CodeMirrorEditor
      documentId={documentId}
      initialValue={initialValue}
      onChange={onChange}
      onReady={onReady}
      extensions={editorExtensions}
      placeholder={placeholder}
    />
  );
}
