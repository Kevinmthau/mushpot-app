import type { EmailOtpType } from "@supabase/supabase-js";
import Link from "next/link";
import { redirect } from "next/navigation";

import { verifyEmailLinkAction } from "@/app/auth/verify/actions";
import { normalizeInternalPath } from "@/lib/app-url";

export const dynamic = "force-dynamic";

const EMAIL_OTP_TYPES = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

type VerifyPageProps = {
  searchParams: Promise<{
    code?: string;
    next?: string;
    token_hash?: string;
    type?: string;
  }>;
};

function normalizeEmailOtpType(
  value: string | undefined,
  defaultType: EmailOtpType | null = null,
) {
  if (!value) {
    return defaultType;
  }

  return EMAIL_OTP_TYPES.has(value as EmailOtpType) ? value : null;
}

export default async function VerifyPage({ searchParams }: VerifyPageProps) {
  const { code, next, token_hash: tokenHash, type: rawType } = await searchParams;
  const nextPath = normalizeInternalPath(next);
  const type = normalizeEmailOtpType(rawType, tokenHash ? "email" : null);
  const canVerify = Boolean(tokenHash && type);

  if (code) {
    const confirmParams = new URLSearchParams({ code, next: nextPath });
    redirect(`/auth/confirm?${confirmParams.toString()}`);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] items-center px-4 py-10 sm:px-6 sm:py-20">
      <section className="w-full rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-6 shadow-[0_12px_32px_rgba(40,52,55,0.08)] sm:p-8">
        <h1 className="font-[var(--font-writing)] text-2xl font-semibold tracking-tight text-[var(--ink)] sm:text-3xl">
          Secure sign-in
        </h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Continue to finish opening Mushpot on this device.
        </p>

        {canVerify ? (
          <form action={verifyEmailLinkAction}>
            <input type="hidden" name="nextPath" value={nextPath} />
            <input type="hidden" name="tokenHash" value={tokenHash} />
            <input type="hidden" name="type" value={type!} />
            <button
              type="submit"
              className="mt-6 w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-[rgba(47,89,102,0.25)]"
            >
              Continue
            </button>
          </form>
        ) : (
          <>
            <p className="mt-4 text-sm text-[#9b2d34]">
              This sign-in link is invalid or has expired.
            </p>
            <Link
              href={`/auth?next=${encodeURIComponent(nextPath)}`}
              className="mt-6 block w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-center text-sm font-semibold text-white transition hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-[rgba(47,89,102,0.25)]"
            >
              Request a new link
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
