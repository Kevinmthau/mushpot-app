"use client";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { useEffect, useRef } from "react";

type CodeMirrorEditorProps = {
  documentId: string;
  initialValue: string;
  onChange?: (doc: Text) => void;
  extensions: Extension[];
  editable?: boolean;
  readOnly?: boolean;
  placeholder?: string;
};

export function CodeMirrorEditor({
  documentId,
  initialValue,
  onChange,
  extensions,
  editable = true,
  readOnly = false,
  placeholder,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const editorExtensions: Extension[] = [
      history(),
      indentOnInput(),
      bracketMatching(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.editable.of(editable),
      EditorState.readOnly.of(readOnly),
      ...extensions,
    ];

    if (onChangeRef.current) {
      editorExtensions.push(
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || !onChangeRef.current) {
            return;
          }

          onChangeRef.current(update.state.doc);
        }),
      );
    }

    if (placeholder) {
      editorExtensions.unshift(placeholderExtension(placeholder));
    }

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: initialValue,
        extensions: editorExtensions,
      }),
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
      }
    };
  }, [documentId, editable, extensions, initialValue, placeholder, readOnly]);

  return <div ref={containerRef} className="cm-theme" />;
}
