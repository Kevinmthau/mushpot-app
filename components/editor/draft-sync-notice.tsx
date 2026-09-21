"use client";

import type { DraftSaveStatus } from "@/components/editor/document-draft-controller";

type DraftSyncNoticeProps = {
  status: DraftSaveStatus;
  isCloning: boolean;
  isDeleting: boolean;
  onSaveCopy: () => void;
  getLatestTitle: () => string;
  getLatestContent: () => string;
};

export function DraftSyncNotice({
  status,
  isCloning,
  isDeleting,
  onSaveCopy,
  getLatestTitle,
  getLatestContent,
}: DraftSyncNoticeProps) {
  if (status === "retryable") {
    return (
      <p role="status" className="mb-4 text-sm text-[var(--muted)]">
        Changes haven’t synced yet. Retrying when connected.
      </p>
    );
  }
  if (status !== "conflict") return null;

  const downloadDraft = () => {
    const title = getLatestTitle().trim() || "Untitled";
    const url = URL.createObjectURL(
      new Blob([`# ${title}\n\n${getLatestContent()}`], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_")}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div
      role="alert"
      className="mb-5 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--ink)]"
    >
      <p className="font-medium">This document changed elsewhere.</p>
      <p className="mt-1 text-[var(--muted)]">
        Your text is still here. Save it as a separate copy or download it
        before reviewing the other version.
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        <button
          type="button"
          className="underline underline-offset-4 disabled:opacity-60"
          disabled={isCloning || isDeleting}
          onClick={onSaveCopy}
        >
          {isCloning ? "Saving copy…" : "Save as a copy"}
        </button>
        <button
          type="button"
          className="underline underline-offset-4"
          onClick={downloadDraft}
        >
          Download my draft
        </button>
      </div>
    </div>
  );
}
