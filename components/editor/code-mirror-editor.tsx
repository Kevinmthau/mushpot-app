"use client";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { useEffect, useRef } from "react";

type CodeMirrorEditorProps = {
  value: string;
  onChange: (value: string) => void;
  extensions: Extension[];
  placeholder?: string;
};

export function CodeMirrorEditor({
  value,
  onChange,
  extensions,
  placeholder,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const extensionsRef = useRef(extensions);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    extensionsRef.current = extensions;
  }, [extensions]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || viewRef.current) {
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

        onChangeRef.current(update.state.doc.toString());
      }),
      ...extensionsRef.current,
    ];

    if (placeholder) {
      editorExtensions.unshift(placeholderExtension(placeholder));
    }

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: value,
        extensions: editorExtensions,
      }),
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [placeholder, value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const currentValue = view.state.doc.toString();
    if (value === currentValue) {
      return;
    }

    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
  }, [value]);

  return <div ref={containerRef} className="cm-theme" />;
}
