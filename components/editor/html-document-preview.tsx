"use client";

import { useMemo, useState } from "react";

import {
  buildHtmlPreviewDocument,
  HTML_INTERACTIVE_PREVIEW_SANDBOX,
  HTML_PREVIEW_SANDBOX,
} from "@/lib/html-document";

type HtmlDocumentPreviewProps = {
  allowInteractionsControl?: boolean;
  className?: string;
  source: string;
  title: string;
};

export function HtmlDocumentPreview({
  allowInteractionsControl = false,
  className = "",
  source,
  title,
}: HtmlDocumentPreviewProps) {
  const [interactionsEnabled, setInteractionsEnabled] = useState(false);
  const srcDoc = useMemo(
    () => buildHtmlPreviewDocument(source, interactionsEnabled),
    [interactionsEnabled, source],
  );

  return (
    <div className={`flex min-h-0 flex-col ${className}`.trim()}>
      {allowInteractionsControl ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-xs text-[var(--muted)]">
          <span>
            Scripts are {interactionsEnabled ? "enabled for this preview only" : "off"}.
          </span>
          <button
            type="button"
            aria-pressed={interactionsEnabled}
            onClick={() => setInteractionsEnabled((enabled) => !enabled)}
            className="rounded-md border border-[var(--line)] bg-white px-2 py-1 text-[var(--ink)]"
          >
            {interactionsEnabled ? "Disable interactions" : "Enable interactions"}
          </button>
        </div>
      ) : null}
      <iframe
        className="min-h-[60vh] w-full flex-1 rounded-xl border border-[var(--line)] bg-white"
        referrerPolicy="no-referrer"
        sandbox={
          interactionsEnabled
            ? HTML_INTERACTIVE_PREVIEW_SANDBOX
            : HTML_PREVIEW_SANDBOX
        }
        srcDoc={srcDoc}
        title={`${title.trim() || "Untitled"} HTML preview`}
      />
    </div>
  );
}
