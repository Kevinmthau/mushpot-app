"use client";

import { useDocumentShare } from "@/components/editor/use-document-share";

type ShareModalProps = {
  documentId: string;
  getDocumentText: () => string;
  getDocumentTitle: () => string;
  isOpen: boolean;
  onClose: () => void;
  shareEnabled: boolean;
  shareToken: string | null;
  onShareUpdated: (enabled: boolean, token: string | null, updatedAt: string) => void;
};

export function ShareModal({
  documentId,
  getDocumentText,
  getDocumentTitle,
  isOpen,
  onClose,
  shareEnabled,
  shareToken,
  onShareUpdated,
}: ShareModalProps) {
  const {
    busyAction,
    copiedAction,
    error,
    handleCopyLink,
    handleCopyText,
    handleDisable,
    handleEnable,
    handleRotate,
    shareUrl,
  } = useDocumentShare({
    documentId,
    getDocumentText,
    getDocumentTitle,
    onShareUpdated,
    shareEnabled,
    shareToken,
  });

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-[rgba(12,17,18,0.4)] px-4 py-4 sm:items-center sm:py-6">
      <div className="my-auto w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-[0_16px_32px_rgba(17,23,26,0.24)] sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4 sm:mb-6">
          <div>
            <h2 className="font-[var(--font-writing)] text-xl font-semibold text-[var(--ink)] sm:text-2xl">
              Share document
            </h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Create a private read-only link for this document.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-[var(--muted)] transition hover:bg-[rgba(47,89,102,0.08)]"
            aria-label="Close sharing modal"
          >
            ✕
          </button>
        </div>

        <div className="break-all rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-sm text-[var(--muted)]">
          {shareEnabled && shareToken ? shareUrl : "Sharing is currently disabled."}
        </div>

        <label className="mt-4 flex items-center justify-between rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-sm text-[var(--ink)]">
          <span>Enable share link</span>
          <input
            type="checkbox"
            checked={shareEnabled}
            disabled={busyAction !== null}
            onChange={(event) => {
              if (event.target.checked) {
                void handleEnable();
              } else {
                void handleDisable();
              }
            }}
            className="h-4 w-4 accent-[var(--accent)]"
          />
        </label>

        <div className="mt-4 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <button
            type="button"
            onClick={handleCopyLink}
            disabled={busyAction !== null || !shareEnabled || !shareToken}
            className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-55 sm:w-auto"
          >
            {copiedAction === "link" ? "Link copied" : "Copy link"}
          </button>

          <button
            type="button"
            onClick={handleCopyText}
            disabled={busyAction !== null}
            className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-55 sm:w-auto"
          >
            {copiedAction === "text" ? "Text copied" : "Copy text"}
          </button>

          <button
            type="button"
            onClick={handleRotate}
            disabled={busyAction !== null || !shareEnabled}
            className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-55 sm:w-auto"
          >
            Rotate link
          </button>

          <button
            type="button"
            onClick={handleDisable}
            disabled={busyAction !== null || !shareEnabled}
            className="w-full rounded-lg bg-[#6a2d35] px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-55 sm:w-auto"
          >
            Disable sharing
          </button>
        </div>

        {error ? <p className="mt-4 text-sm text-[#9b2d34]">{error}</p> : null}
      </div>
    </div>
  );
}
