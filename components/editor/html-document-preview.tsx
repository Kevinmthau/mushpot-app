"use client";

import { useMemo } from "react";

import {
  buildHtmlPreviewDocument,
  HTML_PREVIEW_SANDBOX,
} from "@/lib/html-document";

type HtmlDocumentPreviewProps = {
  className?: string;
  source: string;
  title: string;
};

export function HtmlDocumentPreview({
  className = "",
  source,
  title,
}: HtmlDocumentPreviewProps) {
  const srcDoc = useMemo(
    () => buildHtmlPreviewDocument(source),
    [source],
  );

  return (
    <div className={`flex min-h-0 flex-col ${className}`.trim()}>
      <iframe
        className="min-h-[60vh] w-full flex-1 rounded-xl border border-[var(--line)] bg-white"
        referrerPolicy="no-referrer"
        sandbox={HTML_PREVIEW_SANDBOX}
        srcDoc={srcDoc}
        title={`${title.trim() || "Untitled"} HTML preview`}
      />
    </div>
  );
}
