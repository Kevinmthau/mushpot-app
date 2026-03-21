"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function AuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    // The browser client with detectSessionInUrl: true automatically
    // picks up the access_token / refresh_token from the URL hash
    // (implicit flow) and fires SIGNED_IN via onAuthStateChange.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        router.replace(next);
      }
    });

    // Fallback: if the session was already detected before the listener
    // was registered (race condition), check manually after a short delay.
    const timeout = setTimeout(async () => {
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
    }, 3000);

    return () => {
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
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
