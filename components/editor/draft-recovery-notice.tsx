type DraftRecoveryNoticeProps = {
  isCloning: boolean;
  isDeleting: boolean;
  onSaveCopy: () => void;
};

export function DraftRecoveryNotice({
  isCloning,
  isDeleting,
  onSaveCopy,
}: DraftRecoveryNoticeProps) {
  return (
    <div
      role="status"
      className="mb-6 rounded-xl border border-[var(--line)] px-4 py-3 text-sm leading-6 text-[var(--muted)]"
    >
      <p>
        This draft is saved on this device but can’t sync automatically. Save a
        copy to keep your edits online.
      </p>
      <button
        type="button"
        onClick={onSaveCopy}
        disabled={isCloning || isDeleting}
        className="mt-2 text-[var(--ink)] underline underline-offset-4 transition hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isCloning ? "Saving copy…" : "Save a copy"}
      </button>
    </div>
  );
}
