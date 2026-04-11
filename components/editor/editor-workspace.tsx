"use client";

import { markdown } from "@codemirror/lang-markdown";
import {
  EditorState,
  Transaction,
  type ChangeSpec,
  type Text,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo } from "react";

import {
  editorTheme,
  markdownLiveFormatting,
} from "@/components/editor/editor-appearance";
import { CodeMirrorEditor } from "@/components/editor/code-mirror-editor";
import { useImageUploadInsertion } from "@/components/editor/use-image-upload";

// iOS Safari does not reliably honor autocapitalize="sentences" inside
// CodeMirror's contenteditable, so the first letter typed into an empty
// document (e.g. right after tapping into the body of a new document) comes
// through lowercase. This transaction filter detects a single lowercase
// letter inserted at a sentence boundary and rewrites it to uppercase.
function isSentenceStart(doc: Text, pos: number) {
  let i = pos;
  while (i > 0) {
    i -= 1;
    const ch = doc.sliceString(i, i + 1);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      continue;
    }
    return ch === "." || ch === "!" || ch === "?";
  }
  return true;
}

const autoCapitalizeSentences = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) {
    return tr;
  }

  // Only rewrite plain typed input; leave paste, drop, undo/redo, and IME
  // composition alone so we don't interfere with autocorrect or multi-step
  // input.
  if (tr.annotation(Transaction.userEvent) !== "input.type") {
    return tr;
  }

  const startDoc = tr.startState.doc;
  const fixups: ChangeSpec[] = [];

  tr.changes.iterChanges((fromA, _toA, fromB, _toB, inserted) => {
    if (inserted.length !== 1) {
      return;
    }
    const text = inserted.sliceString(0, 1);
    if (text < "a" || text > "z") {
      return;
    }
    if (!isSentenceStart(startDoc, fromA)) {
      return;
    }
    fixups.push({ from: fromB, to: fromB + 1, insert: text.toUpperCase() });
  });

  if (fixups.length === 0) {
    return tr;
  }

  return [tr, { changes: fixups, sequential: true }];
});

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
      autoCapitalizeSentences,
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
