"use client";

import { useFormStatus } from "react-dom";

type AuthSubmitButtonProps = {
  disabled?: boolean;
};

export function AuthSubmitButton({ disabled = false }: AuthSubmitButtonProps) {
  const { pending } = useFormStatus();
  const isDisabled = pending || disabled;

  return (
    <button
      type="submit"
      aria-disabled={isDisabled}
      disabled={isDisabled}
      className="mt-6 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Sending magic link..." : "Send magic link"}
    </button>
  );
}
