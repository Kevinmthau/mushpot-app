"use client";

import { useEffect, useEffectEvent } from "react";
import { useRouter, usePathname } from "next/navigation";

import { clearLastActiveOwner, setLastActiveOwner } from "@/lib/doc-cache";

/**
 * Subscribes to Supabase auth state changes so the PWA detects
 * session expiry / refresh even after being backgrounded on mobile.
 *
 * Mounted in the private layout so it only runs on authenticated routes.
 */
export function AuthPersistence() {
  const router = useRouter();
  const pathname = usePathname();
  const redirectToAuth = useEffectEvent(() => {
    router.replace(`/auth?next=${encodeURIComponent(pathname)}`);
  });

  useEffect(() => {
    let isActive = true;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
      const supabase = await getSupabaseBrowserClient();

      if (!isActive) {
        return;
      }

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
          if (session?.user?.id) {
            void setLastActiveOwner(session.user.id);
          }
        }

        if (event === "SIGNED_OUT") {
          void clearLastActiveOwner();
          redirectToAuth();
        }
      });

      unsubscribe = () => subscription.unsubscribe();

      // On mount, also do a one-time session check to catch stale cookies
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!isActive) {
        unsubscribe?.();
        return;
      }

      if (session?.user?.id) {
        void setLastActiveOwner(session.user.id);
      } else {
        void clearLastActiveOwner();
        redirectToAuth();
      }
    })();

    return () => {
      isActive = false;
      unsubscribe?.();
    };
  }, []);

  return null;
}
