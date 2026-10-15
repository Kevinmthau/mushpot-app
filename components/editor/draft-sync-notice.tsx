"use client";

import type { DraftSaveStatus } from "@/components/editor/document-draft-controller";

type DraftSyncNoticeProps = {
  draftSerializationError: string | null;
  status: DraftSaveStatus;
  isCloning: boolean;
  isDeleting: boolean;
  isDownloading: boolean;
  onSaveCopy: () => void;
  onDownload: () => void;
};

export function DraftSyncNotice({
  draftSerializationError,
  status,
  isCloning,
  isDeleting,
  isDownloading,
  onSaveCopy,
  onDownload,
}: DraftSyncNoticeProps) {
  if (draftSerializationError) {
    return (
      <div
        role="alert"
        className="mb-5 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--ink)]"
      >
        <p className="font-medium">This page can’t be saved yet.</p>
        <p className="mt-1 text-[var(--muted)]">
          {draftSerializationError}
        </p>
      </div>
    );
  }

  if (status === "retryable") {
    return (
      <p role="status" className="mb-4 text-sm text-[var(--muted)]">
        Changes haven’t synced yet. Retrying when connected.
      </p>
    );
  }
  if (status !== "conflict") return null;

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
          disabled={isDownloading || isDeleting}
          onClick={onDownload}
        >
          {isDownloading ? "Preparing HTML…" : "Download my draft as HTML"}
        </button>
      </div>
    </div>
  );
}
