"use client";

import { useFormStatus } from "react-dom";

export function AuthSubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      aria-disabled={pending}
      disabled={pending}
      className="mt-6 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Sending magic link..." : "Send magic link"}
    </button>
  );
}
