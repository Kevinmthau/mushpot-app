"use client";

import { useMemo, useState } from "react";
import { customAlphabet } from "nanoid";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type ShareModalProps = {
  documentId: string;
  isOpen: boolean;
  onClose: () => void;
  shareEnabled: boolean;
  shareToken: string | null;
  onShareUpdated: (enabled: boolean, token: string | null) => void;
};

const tokenGenerator = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_",
  64,
);

export function ShareModal({
  documentId,
  isOpen,
  onClose,
  shareEnabled,
  shareToken,
  onShareUpdated,
}: ShareModalProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [busyAction, setBusyAction] = useState<
    "enable" | "rotate" | "disable" | "copy" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) {
    return null;
  }

  const shareUrl =
    shareEnabled && shareToken
      ? `${window.location.origin}/s/${documentId}/${shareToken}`
      : "";

  const updateShareState = async (enabled: boolean, token: string | null) => {
    const { error: updateError } = await supabase
      .from("documents")
      .update({
        share_enabled: enabled,
        share_token: token,
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    onShareUpdated(enabled, token);
  };

  const handleEnable = async () => {
    setBusyAction("enable");
    setError(null);

    try {
      const nextToken = shareToken ?? tokenGenerator();
      await updateShareState(true, nextToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to enable sharing.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleRotate = async () => {
    setBusyAction("rotate");
    setError(null);

    try {
      await updateShareState(true, tokenGenerator());
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rotate link.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleDisable = async () => {
    setBusyAction("disable");
    setError(null);

    try {
      await updateShareState(false, null);
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to disable sharing.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) {
      return;
    }

    setBusyAction("copy");
    setError(null);

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setError("Clipboard access was blocked. Copy manually.");
    } finally {
      setBusyAction(null);
    }
  };

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
            onClick={handleCopy}
            disabled={busyAction !== null || !shareEnabled || !shareToken}
            className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-55 sm:w-auto"
          >
            {copied ? "Copied" : "Copy link"}
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
