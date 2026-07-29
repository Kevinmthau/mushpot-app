"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";

import { usePrivateSession } from "@/components/pwa/private-session-provider";
import {
  activateDocumentCacheForOwner,
  clearCachedDocumentsForOwner,
  clearLastActiveOwner,
} from "@/lib/doc-cache";
import { clearPrivateNavigationCache } from "@/lib/private-navigation-cache";

/**
 * Subscribes to Supabase auth state changes so the PWA detects
 * session expiry / refresh even after being backgrounded on mobile.
 *
 * Mounted in the private layout so it only runs on authenticated routes.
 */
export function AuthPersistence() {
  const router = useRouter();
  const pathname = usePathname();
  const { clearUserId, setUserId, userId } = usePrivateSession();
  const activeOwnerRef = useRef(userId);
  const redirectToAuth = useEffectEvent(() => {
    router.replace(`/auth?next=${encodeURIComponent(pathname)}`);
  });

  useEffect(() => {
    activeOwnerRef.current = userId;
  }, [userId]);

  useEffect(() => {
    let isActive = true;
    let unsubscribe: (() => void) | undefined;
    let authEventVersion = 0;

    void (async () => {
      const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
      const supabase = await getSupabaseBrowserClient();

      if (!isActive) {
        return;
      }

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((event, session) => {
        authEventVersion += 1;

        if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
          if (session?.user?.id) {
            const nextOwner = session.user.id;
            const previousOwner = activeOwnerRef.current;

            if (previousOwner && previousOwner !== nextOwner) {
              void clearCachedDocumentsForOwner(previousOwner);
              void clearPrivateNavigationCache();
            }

            activeOwnerRef.current = nextOwner;
            setUserId(nextOwner);
            void activateDocumentCacheForOwner(nextOwner);
          }
        }

        if (event === "SIGNED_OUT") {
          const signedOutOwner = activeOwnerRef.current;
          activeOwnerRef.current = null;
          clearUserId();
          void Promise.all([
            signedOutOwner
              ? clearCachedDocumentsForOwner(signedOutOwner)
              : Promise.resolve(),
            clearLastActiveOwner(),
            clearPrivateNavigationCache(),
          ]).finally(redirectToAuth);
        }
      });

      unsubscribe = () => subscription.unsubscribe();

      // On mount, also do a one-time session check to catch stale cookies
      const sessionCheckVersion = authEventVersion;
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!isActive) {
        unsubscribe?.();
        return;
      }

      if (sessionCheckVersion !== authEventVersion) {
        return;
      }

      if (session?.user?.id) {
        const nextOwner = session.user.id;
        const previousOwner = activeOwnerRef.current;

        if (previousOwner && previousOwner !== nextOwner) {
          void clearCachedDocumentsForOwner(previousOwner);
          void clearPrivateNavigationCache();
        }

        activeOwnerRef.current = nextOwner;
        setUserId(nextOwner);
        void activateDocumentCacheForOwner(nextOwner);
      } else {
        const signedOutOwner = activeOwnerRef.current;
        activeOwnerRef.current = null;
        clearUserId();
        void Promise.all([
          signedOutOwner
            ? clearCachedDocumentsForOwner(signedOutOwner)
            : Promise.resolve(),
          clearLastActiveOwner(),
          clearPrivateNavigationCache(),
        ]).finally(redirectToAuth);
      }
    })();

    return () => {
      isActive = false;
      unsubscribe?.();
    };
  }, [clearUserId, setUserId]);

  return null;
}
