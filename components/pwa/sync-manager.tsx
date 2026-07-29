"use client";

import { useEffect } from "react";

import { usePrivateSession } from "@/components/pwa/private-session-provider";

/**
 * Flushes dirty documents and resumes durable document maintenance on startup,
 * when coming back online, and when the app becomes visible again. Also
 * retries both every 30 seconds.
 */
export function SyncManager() {
  const { userId } = usePrivateSession();

  useEffect(() => {
    if (!userId) {
      return;
    }

    let isMounted = true;
    let flushInProgress = false;
    const owner = userId;

    async function flushDirtyDocs() {
      if (flushInProgress || !isMounted) return;
      flushInProgress = true;

      try {
        const [{ flushDirtyDocuments }, { runDocumentMaintenance }] =
          await Promise.all([
            import("@/lib/document-sync"),
            import("@/lib/document-maintenance"),
          ]);
        await Promise.allSettled([
          flushDirtyDocuments(owner),
          runDocumentMaintenance(owner),
        ]);
      } catch {
        // Best-effort — will retry on next trigger
      } finally {
        flushInProgress = false;
      }
    }

    // Flush on mount (app startup)
    void flushDirtyDocs();

    // Flush when coming back online
    const handleOnline = () => void flushDirtyDocs();
    window.addEventListener("online", handleOnline);

    // Flush when app becomes visible again (e.g. returning from another app on mobile)
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void flushDirtyDocs();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    // Periodic retry every 30 seconds
    const intervalId = setInterval(() => void flushDirtyDocs(), 30_000);

    return () => {
      isMounted = false;
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(intervalId);
    };
  }, [userId]);

  return null;
}
