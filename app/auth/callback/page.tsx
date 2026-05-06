"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { normalizeInternalPath } from "@/lib/app-url";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = normalizeInternalPath(searchParams.get("next"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    // Check if the session was already established by the server-side
    // PKCE exchange in /auth/confirm. If so, redirect immediately.
    const checkSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session) {
        router.replace(next);
      } else {
        setError(
          "Unable to complete sign-in. The link may have expired. Please request a new magic link.",
        );
      }
    };

    const timeout = setTimeout(checkSession, 500);
    return () => clearTimeout(timeout);
  }, [next, router]);

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-6 text-center shadow-[0_12px_32px_rgba(40,52,55,0.08)] sm:p-8">
          <p className="text-sm text-[#9b2d34]">{error}</p>
          <a
            href={`/auth?next=${encodeURIComponent(next)}`}
            className="mt-4 inline-block text-sm font-medium text-[var(--accent)] underline"
          >
            Back to sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <p className="text-sm text-[var(--muted)]">Completing sign-in&hellip;</p>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center px-4">
          <p className="text-sm text-[var(--muted)]">Completing sign-in&hellip;</p>
        </div>
      }
    >
      <AuthCallbackInner />
    </Suspense>
  );
}
