"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";

import { setLastActiveOwner, clearLastActiveOwner } from "@/lib/doc-cache";

/**
 * Subscribes to Supabase auth state changes so the PWA detects
 * session expiry / refresh even after being backgrounded on mobile.
 *
 * Placed in the root layout so it runs on every page.
 */
export function AuthPersistence() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const { createSupabaseBrowserClient } = await import(
        "@/lib/supabase/client"
      );
      const supabase = createSupabaseBrowserClient();

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((event: string, session: { user?: { id?: string } } | null) => {
        if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
          if (session?.user?.id) {
            void setLastActiveOwner(session.user.id);
          }
        }

        if (event === "SIGNED_OUT") {
          void clearLastActiveOwner();
          // Only redirect if not already on /auth
          if (!pathname.startsWith("/auth")) {
            router.replace("/auth");
          }
        }
      });

      unsubscribe = () => subscription.unsubscribe();

      // On mount, also do a one-time session check to catch stale cookies
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session?.user?.id) {
        void setLastActiveOwner(session.user.id);
      } else if (
        !pathname.startsWith("/auth") &&
        !pathname.startsWith("/s/")
      ) {
        // No valid session and not on a public route — redirect to login
        router.replace(`/auth?next=${encodeURIComponent(pathname)}`);
      }
    })();

    return () => {
      unsubscribe?.();
    };
  }, [router, pathname]);

  return null;
}
