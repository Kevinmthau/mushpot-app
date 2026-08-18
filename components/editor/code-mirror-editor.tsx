"use client";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  EditorState,
  Transaction,
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

export type CodeMirrorEditorApi = {
  focus: () => void;
};

type CodeMirrorEditorProps = {
  documentId: string;
  initialValue: string;
  onChange?: (doc: Text) => void;
  onReady?: (api: CodeMirrorEditorApi | null) => void;
  extensions: Extension[];
  editable?: boolean;
  readOnly?: boolean;
  placeholder?: string;
};

export type EditorValueHandoffState = Readonly<{
  documentId: string;
  hasLocalEdits: boolean;
  value: string | Text;
}>;

export function createEditorValueHandoffState(
  documentId: string,
  value: string | Text,
): EditorValueHandoffState {
  return { documentId, hasLocalEdits: false, value };
}

export function activateEditorValueHandoff(
  current: EditorValueHandoffState,
  documentId: string,
  initialValue: string,
) {
  return current.documentId === documentId
    ? current
    : createEditorValueHandoffState(documentId, initialValue);
}

export function recordLocalEditorValue(
  current: EditorValueHandoffState,
  documentId: string,
  value: string | Text,
): EditorValueHandoffState {
  return {
    documentId,
    hasLocalEdits: true,
    value,
  };
}

function recordEditorViewValue(
  current: EditorValueHandoffState,
  documentId: string,
  value: string | Text,
): EditorValueHandoffState {
  return current.documentId === documentId
    ? { ...current, value }
    : createEditorValueHandoffState(documentId, value);
}

export function acceptExternalEditorValue(
  current: EditorValueHandoffState,
  documentId: string,
  value: string,
): {
  state: EditorValueHandoffState;
  valueToApply: string | null;
} {
  if (current.documentId !== documentId) {
    return {
      state: createEditorValueHandoffState(documentId, value),
      valueToApply: value,
    };
  }

  if (current.hasLocalEdits) {
    return { state: current, valueToApply: null };
  }

  const currentValueMatches =
    typeof current.value === "string"
      ? current.value === value
      : current.value.toString() === value;

  if (currentValueMatches) {
    return { state: current, valueToApply: null };
  }

  return {
    state: { ...current, value },
    valueToApply: value,
  };
}

export function CodeMirrorEditor({
  documentId,
  initialValue,
  onChange,
  onReady,
  extensions,
  editable = true,
  readOnly = false,
  placeholder,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const restoreFocusRef = useRef(false);
  const applyingExternalValueRef = useRef(false);
  const initialValueRef = useRef(initialValue);
  const valueHandoffRef = useRef(
    createEditorValueHandoffState(documentId, initialValue),
  );
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  const editorApiRef = useRef<CodeMirrorEditorApi>({
    focus: () => {
      viewRef.current?.focus();
    },
  });

  initialValueRef.current = initialValue;

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const previousOnReady = onReadyRef.current;
    if (previousOnReady !== onReady) {
      previousOnReady?.(null);
      onReadyRef.current = onReady;
    }

    if (viewRef.current) {
      onReady?.(editorApiRef.current);
    }
  }, [onReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    valueHandoffRef.current = activateEditorValueHandoff(
      valueHandoffRef.current,
      documentId,
      initialValueRef.current,
    );

    const editorExtensions: Extension[] = [
      history(),
      indentOnInput(),
      bracketMatching(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.editable.of(editable),
      EditorState.readOnly.of(readOnly),
      ...extensions,
    ];

    editorExtensions.push(
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          return;
        }

        const nextValue = update.state.doc;
        if (applyingExternalValueRef.current) {
          valueHandoffRef.current = recordEditorViewValue(
            valueHandoffRef.current,
            documentId,
            nextValue,
          );
          return;
        }

        valueHandoffRef.current = recordLocalEditorValue(
          valueHandoffRef.current,
          documentId,
          nextValue,
        );

        onChangeRef.current?.(update.state.doc);
      }),
    );

    if (placeholder) {
      editorExtensions.unshift(placeholderExtension(placeholder));
    }

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: valueHandoffRef.current.value,
        extensions: editorExtensions,
      }),
    });

    viewRef.current = view;
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      view.focus();
    }
    onReadyRef.current?.(editorApiRef.current);

    return () => {
      // React Strict Mode and extension changes can recreate the EditorView.
      // Carry focus to the replacement so a title-to-body transfer is not
      // lost when the first ready editor is immediately torn down.
      restoreFocusRef.current = view.hasFocus;
      if (valueHandoffRef.current.documentId === documentId) {
        valueHandoffRef.current = recordEditorViewValue(
          valueHandoffRef.current,
          documentId,
          view.state.doc,
        );
      }
      onReadyRef.current?.(null);
      view.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
      }
    };
  }, [documentId, editable, extensions, placeholder, readOnly]);

  useEffect(() => {
    const accepted = acceptExternalEditorValue(
      valueHandoffRef.current,
      documentId,
      initialValue,
    );
    valueHandoffRef.current = accepted.state;

    const view = viewRef.current;
    if (
      accepted.valueToApply === null ||
      !view ||
      view.state.doc.toString() === accepted.valueToApply
    ) {
      return;
    }

    applyingExternalValueRef.current = true;
    try {
      view.dispatch({
        annotations: Transaction.addToHistory.of(false),
        changes: {
          from: 0,
          insert: accepted.valueToApply,
          to: view.state.doc.length,
        },
      });
    } finally {
      applyingExternalValueRef.current = false;
    }
  }, [documentId, initialValue]);

  return <div ref={containerRef} className="cm-theme" />;
}
