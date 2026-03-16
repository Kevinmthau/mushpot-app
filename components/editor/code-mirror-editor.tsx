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
  onChange: (doc: Text) => void;
  extensions: Extension[];
  placeholder?: string;
};

export function CodeMirrorEditor({
  documentId,
  initialValue,
  onChange,
  extensions,
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
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          return;
        }

        onChangeRef.current(update.state.doc);
      }),
      ...extensions,
    ];

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
  }, [documentId, extensions, initialValue, placeholder]);

  return <div ref={containerRef} className="cm-theme" />;
}
