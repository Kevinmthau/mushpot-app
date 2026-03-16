"use client";

import { useEffect } from "react";

import { flushDirtyDocuments } from "@/lib/document-sync";

/**
 * Flushes dirty (unsaved) documents to Supabase on startup,
 * when coming back online, and when the app becomes visible again.
 * Also periodically retries dirty docs every 30 seconds.
 */
export function SyncManager() {
  useEffect(() => {
    let isMounted = true;
    let flushInProgress = false;

    async function flushDirtyDocs() {
      if (flushInProgress || !isMounted) return;
      flushInProgress = true;

      try {
        await flushDirtyDocuments();
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
  }, []);

  return null;
}
