"use client";

import { html } from "@codemirror/lang-html";
import {
  EditorState,
  StateField,
  type Extension,
  type Text,
  type Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CodeMirrorEditor, type CodeMirrorEditorApi } from "@/components/editor/code-mirror-editor";
import { editorTheme } from "@/components/editor/editor-appearance";
import { HtmlDocumentPreview } from "@/components/editor/html-document-preview";
import {
  getUtf8ByteLength,
  HTML_FULL_HIGHLIGHT_MAX_BYTES,
  HTML_CONTENT_MAX_BYTES,
  isHtmlDocumentTextFragmentValid,
} from "@/lib/html-document";

export const HTML_PREVIEW_DEBOUNCE_MS = 600;

type HtmlEditorMode = "source" | "split" | "preview";

function getHtmlTransactionUtf8ByteLength(
  transaction: Transaction,
  currentUtf8ByteLength: number,
) {
  let nextUtf8ByteLength = currentUtf8ByteLength;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    nextUtf8ByteLength -= getUtf8ByteLength(
      transaction.startState.sliceDoc(fromA, toA),
    );
    nextUtf8ByteLength += getUtf8ByteLength(
      transaction.newDoc.sliceString(fromB, toB),
    );
  });
  return nextUtf8ByteLength;
}

function hasValidHtmlTransactionText(transaction: Transaction) {
  let valid = true;
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    // Include both UTF-16 code units on either side so a valid surrogate pair
    // adjacent to an edit is inspected, then align the fragment itself to
    // code-point boundaries so it never begins or ends inside another pair.
    let fragmentStart = Math.max(0, fromB - 2);
    let fragmentEnd = Math.min(transaction.newDoc.length, toB + 2);
    const firstCodeUnit = transaction.newDoc
      .sliceString(fragmentStart, fragmentStart + 1)
      .charCodeAt(0);
    const lastCodeUnit = transaction.newDoc
      .sliceString(fragmentEnd - 1, fragmentEnd)
      .charCodeAt(0);
    if (
      fragmentStart > 0 &&
      firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff
    ) {
      fragmentStart -= 1;
    }
    if (
      fragmentEnd < transaction.newDoc.length &&
      lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ) {
      fragmentEnd += 1;
    }
    const fragment = transaction.newDoc.sliceString(
      fragmentStart,
      fragmentEnd,
    );
    if (!isHtmlDocumentTextFragmentValid(fragment)) valid = false;
  });
  return valid;
}

export function isHtmlEditorTransactionAllowed(
  transaction: Transaction,
  currentUtf8ByteLength = getUtf8ByteLength(
    transaction.startState.sliceDoc(),
  ),
) {
  if (!transaction.docChanged) return true;
  return transaction.newDoc.length > 0 &&
    hasValidHtmlTransactionText(transaction) &&
    getHtmlTransactionUtf8ByteLength(transaction, currentUtf8ByteLength) <=
      HTML_CONTENT_MAX_BYTES;
}

const htmlDocumentUtf8ByteLength = StateField.define<number>({
  create: (state) => getUtf8ByteLength(state.sliceDoc()),
  update: (value, transaction) =>
    transaction.docChanged
      ? getHtmlTransactionUtf8ByteLength(transaction, value)
      : value,
});

export function createHtmlEditLimitExtension(
  onRejected: () => void,
  onByteLengthChange?: (byteLength: number) => void,
): Extension {
  return [
    htmlDocumentUtf8ByteLength,
    EditorState.transactionFilter.of((transaction) => {
      const currentUtf8ByteLength = transaction.startState.field(
        htmlDocumentUtf8ByteLength,
      );
      if (
        isHtmlEditorTransactionAllowed(transaction, currentUtf8ByteLength)
      ) {
        return transaction;
      }
      onRejected();
      return [];
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      onByteLengthChange?.(update.state.field(htmlDocumentUtf8ByteLength));
    }),
  ];
}

type HtmlEditorProps = {
  documentId: string;
  initialValue: string;
  onChange: (doc: Text) => void;
  onReady?: (api: CodeMirrorEditorApi | null) => void;
  title: string;
};

export function HtmlEditor({
  documentId,
  initialValue,
  onChange,
  onReady,
  title,
}: HtmlEditorProps) {
  const [mode, setMode] = useState<HtmlEditorMode>("source");
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [previewOverride, setPreviewOverride] = useState<string | null>(null);
  const latestSourceRef = useRef<string | Text>(initialValue);
  const previousInitialValueRef = useRef(initialValue);
  const hasLocalEditsRef = useRef(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fullHighlighting, setFullHighlighting] = useState(
    () => getUtf8ByteLength(initialValue) <= HTML_FULL_HIGHLIGHT_MAX_BYTES,
  );

  const rejectEdit = useCallback(() => {
    setLimitMessage("HTML must stay non-empty valid UTF-8, contain no NUL characters, and be 2 MiB or smaller.");
    setTimeout(() => setLimitMessage(null), 4_000);
  }, []);

  const updateHighlightingForByteLength = useCallback((byteLength: number) => {
    setFullHighlighting(
      byteLength <= HTML_FULL_HIGHLIGHT_MAX_BYTES,
    );
  }, []);

  const extensions = useMemo<Extension[]>(
    () => [
      createHtmlEditLimitExtension(
        rejectEdit,
        updateHighlightingForByteLength,
      ),
      EditorView.lineWrapping,
      editorTheme,
    ],
    [rejectEdit, updateHighlightingForByteLength],
  );
  const highlightingExtension = useMemo<Extension>(
    () => fullHighlighting ? html() : [],
    [fullHighlighting],
  );

  const handleChange = useCallback((doc: Text) => {
    hasLocalEditsRef.current = true;
    latestSourceRef.current = doc;
    onChange(doc);
    if (mode === "source") return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      setPreviewOverride(latestSourceRef.current.toString());
    }, HTML_PREVIEW_DEBOUNCE_MS);
  }, [mode, onChange]);

  useEffect(() => {
    if (previousInitialValueRef.current === initialValue) return;
    previousInitialValueRef.current = initialValue;
    // CodeMirror accepts server hydration only before it has local edits. Keep
    // the preview handoff under the same rule so both surfaces show one source.
    if (hasLocalEditsRef.current) return;
    latestSourceRef.current = initialValue;
  }, [initialValue]);

  const handleModeChange = useCallback((nextMode: HtmlEditorMode) => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    if (nextMode !== "source") {
      setPreviewOverride(
        hasLocalEditsRef.current ? latestSourceRef.current.toString() : null,
      );
    }
    setMode(nextMode);
  }, []);

  useEffect(() => () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
  }, []);

  const sourceVisible = mode !== "preview";
  const previewVisible = mode !== "source";
  const previewSource = previewOverride ?? initialValue;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(["source", "split", "preview"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => handleModeChange(candidate)}
            aria-pressed={mode === candidate}
            className={`${candidate === "split" ? "hidden md:inline-flex" : "inline-flex"} rounded-lg border px-3 py-1.5 text-xs uppercase tracking-[0.08em] ${
              mode === candidate
                ? "border-[var(--accent)] bg-[var(--paper)] text-[var(--ink)]"
                : "border-[var(--line)] text-[var(--muted)]"
            }`}
          >
            {candidate}
          </button>
        ))}
        {!fullHighlighting ? (
          <span className="text-xs text-[var(--muted)]">
            Large file: using lightweight source highlighting.
          </span>
        ) : null}
      </div>

      {limitMessage ? (
        <p role="alert" className="mb-3 text-sm text-[#9b2d34]">{limitMessage}</p>
      ) : null}

      <div className={mode === "split" ? "grid gap-4 md:grid-cols-2" : "block"}>
        <div className={sourceVisible ? "min-w-0" : "hidden"}>
          <CodeMirrorEditor
            documentId={documentId}
            dynamicExtension={highlightingExtension}
            initialValue={initialValue}
            onChange={handleChange}
            onReady={onReady}
            extensions={extensions}
          />
        </div>
        {previewVisible ? (
          <HtmlDocumentPreview
            className="min-w-0"
            source={previewSource}
            title={title}
          />
        ) : null}
      </div>
    </div>
  );
}
