"use client";

import { useEffect } from "react";

import { getDirtyDocuments, putCachedDocument } from "@/lib/doc-cache";

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
        const dirtyDocs = await getDirtyDocuments();
        if (dirtyDocs.length === 0) return;

        const { createSupabaseBrowserClient } = await import(
          "@/lib/supabase/client"
        );
        const supabase = createSupabaseBrowserClient();

        for (const doc of dirtyDocs) {
          if (!isMounted) break;

          const title = doc.title.trim() || "Untitled";
          let saved = false;

          for (let attempt = 0; attempt < 3; attempt++) {
            const { error } = await supabase
              .from("documents")
              .update({ title, content: doc.content })
              .eq("id", doc.id)
              .eq("owner", doc.owner);

            if (!error) {
              saved = true;
              break;
            }

            await new Promise((r) =>
              setTimeout(r, 1000 * Math.pow(2, attempt)),
            );
          }

          if (saved) {
            void putCachedDocument({
              ...doc,
              title,
              _dirty: false,
              updated_at: new Date().toISOString(),
              _localUpdatedAt: Date.now(),
            });
          }
        }
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
