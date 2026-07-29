"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

import { usePrivateSession } from "@/components/pwa/private-session-provider";
import {
  activateDocumentCacheForOwner,
  deactivateDocumentCacheForOwner,
} from "@/lib/doc-cache";
import { subscribeToAuthLifecycleEvents } from "@/lib/auth-lifecycle-events";
import { clearPrivateNavigationCache } from "@/lib/private-navigation-cache";

type AuthPersistenceActions = {
  activateOwner: (owner: string) => Promise<void>;
  clearNavigationCache: () => Promise<void>;
  clearUserId: () => void;
  deactivateOwner: (owner: string) => Promise<void>;
  redirectToAuth: () => void;
  setUserId: (owner: string) => void;
};

export type AuthPersistenceLifecycle = {
  applySessionCheck: (
    owner: string | null,
    error: unknown,
    startVersion: number,
  ) => void;
  beginExplicitSignOut: (owner: string) => void;
  captureVersion: () => number;
  dispose: () => void;
  handleAuthEvent: (event: string, owner: string | null) => void;
  recoverSession: (owner: string) => void;
};

/**
 * Serializes the observable consequences of auth events without awaiting
 * inside Supabase's callback. Cache lifecycle methods perform their own
 * owner-scoped transaction ordering, while the version prevents a stale
 * sign-out cleanup from redirecting after a newer sign-in.
 */
export function createAuthPersistenceLifecycle(
  initialOwner: string | null,
  actions: AuthPersistenceActions,
): AuthPersistenceLifecycle {
  let activeOwner = initialOwner;
  let disposed = false;
  let explicitSignOutOwner: string | null = null;
  let version = 0;

  const activateOwner = (nextOwner: string) => {
    if (disposed) {
      return;
    }

    version += 1;
    const transitionVersion = version;
    const previousOwner = activeOwner;

    if (previousOwner === nextOwner) {
      activeOwner = nextOwner;
      actions.setUserId(nextOwner);
      void actions.activateOwner(nextOwner);
      return;
    }

    // Hide the previous owner's React state before any asynchronous cleanup.
    // The next owner is exposed only after the old cache/navigation state is
    // deactivated and the new cache generation is active.
    activeOwner = null;
    actions.clearUserId();

    void (async () => {
      if (previousOwner) {
        await Promise.allSettled([
          actions.deactivateOwner(previousOwner),
          actions.clearNavigationCache(),
        ]);
      }

      if (disposed || version !== transitionVersion) {
        return;
      }

      await actions.activateOwner(nextOwner);

      if (disposed || version !== transitionVersion) {
        // A sign-out can arrive while activation is in flight. Undo that
        // activation so an unexposed owner never leaves an enabled cache.
        await actions.deactivateOwner(nextOwner);
        return;
      }

      activeOwner = nextOwner;
      actions.setUserId(nextOwner);
    })();
  };

  const deactivateActiveOwner = () => {
    if (disposed) {
      return;
    }

    version += 1;
    const transitionVersion = version;
    const signedOutOwner = activeOwner;
    activeOwner = null;
    actions.clearUserId();

    const cleanupTasks: Promise<void>[] = [actions.clearNavigationCache()];
    if (signedOutOwner) {
      cleanupTasks.push(actions.deactivateOwner(signedOutOwner));
    }

    void Promise.allSettled(cleanupTasks).then(() => {
      if (
        !disposed &&
        version === transitionVersion &&
        activeOwner === null &&
        explicitSignOutOwner !== signedOutOwner
      ) {
        actions.redirectToAuth();
      }
    });
  };

  return {
    applySessionCheck(owner, error, startVersion) {
      // A transient client/session error must not be interpreted as sign-out.
      if (disposed || error || startVersion !== version) {
        return;
      }

      if (owner) {
        activateOwner(owner);
      } else {
        deactivateActiveOwner();
      }
    },
    beginExplicitSignOut(owner) {
      if (disposed) {
        return;
      }

      explicitSignOutOwner = owner;
      version += 1;
    },
    captureVersion() {
      return version;
    },
    dispose() {
      disposed = true;
      version += 1;
    },
    handleAuthEvent(event, owner) {
      if (disposed) {
        return;
      }

      if (
        event === "INITIAL_SESSION" ||
        event === "SIGNED_IN" ||
        event === "TOKEN_REFRESHED"
      ) {
        if (owner) {
          activateOwner(owner);
        } else if (event === "INITIAL_SESSION") {
          deactivateActiveOwner();
        }
        return;
      }

      if (event === "SIGNED_OUT") {
        deactivateActiveOwner();
      }
    },
    recoverSession(owner) {
      if (disposed) {
        return;
      }

      explicitSignOutOwner = null;
      activateOwner(owner);
    },
  };
}

/**
 * Subscribes to Supabase auth state changes so the PWA detects session expiry
 * or refresh after being backgrounded. Unexpected sign-out quarantines dirty
 * drafts; only the explicit sign-out workflow performs a full purge.
 */
export function AuthPersistence() {
  const router = useRouter();
  const pathname = usePathname();
  const { clearUserId, setUserId, userId } = usePrivateSession();
  const initialOwnerRef = useRef(userId);
  const redirectToAuth = useEffectEvent(() => {
    router.replace(`/auth?next=${encodeURIComponent(pathname)}`);
  });

  useEffect(() => {
    let isActive = true;
    let unsubscribe: (() => void) | undefined;
    const lifecycle = createAuthPersistenceLifecycle(initialOwnerRef.current, {
      activateOwner: activateDocumentCacheForOwner,
      clearNavigationCache: clearPrivateNavigationCache,
      clearUserId,
      deactivateOwner: deactivateDocumentCacheForOwner,
      redirectToAuth,
      setUserId,
    });
    const unsubscribeFromLifecycleEvents = subscribeToAuthLifecycleEvents({
      onExplicitSignOutStarted: (owner) => {
        lifecycle.beginExplicitSignOut(owner);
      },
      onSessionRecovered: (owner) => {
        lifecycle.recoverSession(owner);
      },
    });

    void (async () => {
      try {
        const { getSupabaseBrowserClient } = await import(
          "@/lib/supabase/client"
        );
        const supabase = await getSupabaseBrowserClient();

        if (!isActive) {
          return;
        }

        const {
          data: { subscription },
        } = supabase.auth.onAuthStateChange((event, session) => {
          lifecycle.handleAuthEvent(event, session?.user?.id ?? null);
        });
        unsubscribe = () => subscription.unsubscribe();

        const sessionCheckVersion = lifecycle.captureVersion();
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (!isActive) {
          return;
        }

        lifecycle.applySessionCheck(
          session?.user?.id ?? null,
          error,
          sessionCheckVersion,
        );
      } catch {
        // Import/client/session failures are transient. Keep the server-provided
        // owner and cache state unchanged; the auth subscription can recover.
      }
    })();

    return () => {
      isActive = false;
      lifecycle.dispose();
      unsubscribeFromLifecycleEvents();
      unsubscribe?.();
    };
  }, [clearUserId, setUserId]);

  return null;
}
