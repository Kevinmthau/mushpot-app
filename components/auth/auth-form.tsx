"use client";

import { FormEvent, useMemo, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type AuthFormProps = {
  nextPath: string;
};

export function AuthForm({ nextPath }: AuthFormProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setLoading(true);
    setMessage(null);
    setError(null);

    const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
    const isLocalhost =
      window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const redirectOrigin = isLocalhost && configuredAppUrl ? configuredAppUrl : window.location.origin;
    const emailRedirectTo = `${redirectOrigin}/auth/callback?next=${encodeURIComponent(nextPath)}`;

    const { error: signInError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo,
      },
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    setMessage("Check your email for a secure sign-in link.");
    setLoading(false);
  };

  return (
    <form
      onSubmit={onSubmit}
      className="w-full rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-8 shadow-[0_12px_32px_rgba(40,52,55,0.08)]"
    >
      <h1 className="font-[var(--font-writing)] text-3xl font-semibold tracking-tight text-[var(--ink)]">
        Enter your email
      </h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        We&apos;ll send a magic link so you can start writing.
      </p>

      <label className="mt-6 block text-sm text-[var(--muted)]" htmlFor="email">
        Email address
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,89,102,0.2)]"
        placeholder="you@example.com"
      />

      <button
        type="submit"
        disabled={loading}
        className="mt-6 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Sending..." : "Send magic link"}
      </button>

      {message ? <p className="mt-4 text-sm text-[#2e6558]">{message}</p> : null}
      {error ? <p className="mt-4 text-sm text-[#9b2d34]">{error}</p> : null}
    </form>
  );
}
