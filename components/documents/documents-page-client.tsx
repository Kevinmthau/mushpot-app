"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { DocumentListClient } from "@/components/documents/document-list-client";
import { useDocumentList } from "@/components/documents/use-document-list";
import { usePrivateSession } from "@/components/pwa/private-session-provider";
import PullToRefresh from "@/components/pull-to-refresh";
import {
  activateDocumentCacheForOwner,
  purgeDocumentCacheForOwner,
} from "@/lib/doc-cache";
import { flushDirtyDocuments } from "@/lib/document-sync";
import { clearPrivateNavigationCache } from "@/lib/private-navigation-cache";

type CurrentDeviceSignOutOptions = {
  clearNavigationCache: () => Promise<void>;
  owner: string;
  purgeOwnerCache: (owner: string) => Promise<void>;
  signOut: (
    options: { scope: "local" },
  ) => Promise<{ error: unknown | null }>;
};

/**
 * Signs out only the current device and performs destructive cleanup only
 * after Supabase confirms success.
 */
export async function completeCurrentDeviceSignOut({
  clearNavigationCache,
  owner,
  purgeOwnerCache,
  signOut,
}: CurrentDeviceSignOutOptions): Promise<void> {
  const { error } = await signOut({ scope: "local" });
  if (error) {
    throw error instanceof Error ? error : new Error("Unable to sign out.");
  }

  await Promise.all([
    purgeOwnerCache(owner),
    clearNavigationCache(),
  ]);
}

type SignOutPhase = "idle" | "flushing" | "confirm-discard" | "signing-out";

export function DocumentsPageClient() {
  const router = useRouter();
  const { clearUserId, userId } = usePrivateSession();
  const { documents, error, refreshDocuments } = useDocumentList(userId);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signOutPhase, setSignOutPhase] = useState<SignOutPhase>("idle");
  const [unsavedDraftCount, setUnsavedDraftCount] = useState(0);

  const finishSignOut = useCallback(async () => {
    if (!userId) {
      return;
    }

    setSignOutError(null);
    setSignOutPhase("signing-out");

    try {
      const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
      const supabase = await getSupabaseBrowserClient();
      await completeCurrentDeviceSignOut({
        clearNavigationCache: clearPrivateNavigationCache,
        owner: userId,
        purgeOwnerCache: purgeDocumentCacheForOwner,
        signOut: (options) => supabase.auth.signOut(options),
      });
      clearUserId();
      router.replace("/auth");
    } catch (signOutFailure) {
      // SIGNED_OUT can deactivate the cache while signOut is resolving. If
      // Supabase reports failure, restore access for the still-active owner.
      await activateDocumentCacheForOwner(userId);
      setSignOutError(
        signOutFailure instanceof Error
          ? signOutFailure.message
          : "Unable to sign out. Please try again.",
      );
      setSignOutPhase("idle");
    }
  }, [clearUserId, router, userId]);

  const handleSignOut = useCallback(async () => {
    if (!userId || signOutPhase !== "idle") {
      return;
    }

    setSignOutError(null);
    setSignOutPhase("flushing");

    try {
      const result = await flushDirtyDocuments(userId);
      if (result.remaining > 0) {
        setUnsavedDraftCount(result.remaining);
        setSignOutPhase("confirm-discard");
        return;
      }

      await finishSignOut();
    } catch {
      setSignOutError(
        "Unable to check unsaved drafts. Your data was kept and you remain signed in.",
      );
      setSignOutPhase("idle");
    }
  }, [finishSignOut, signOutPhase, userId]);

  const cancelDiscard = useCallback(() => {
    setUnsavedDraftCount(0);
    setSignOutPhase("idle");
  }, []);

  if (!userId) {
    return null;
  }

  const isBusy =
    signOutPhase === "flushing" || signOutPhase === "signing-out";
  const signOutLabel =
    signOutPhase === "flushing"
      ? "Saving drafts…"
      : signOutPhase === "signing-out"
        ? "Signing out…"
        : "Sign out";

  return (
    <PullToRefresh onRefresh={refreshDocuments}>
      <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-8 sm:px-6 sm:py-12">
        <header className="mb-6 flex flex-col items-end gap-2 sm:mb-10">
          <button
            type="button"
            onClick={() => {
              void handleSignOut();
            }}
            disabled={signOutPhase !== "idle"}
            className="rounded-xl bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--muted)] transition hover:text-[var(--accent)] disabled:opacity-60"
          >
            {signOutLabel}
          </button>
          {signOutError ? (
            <p
              className="max-w-md text-right text-sm text-[#9b2d34]"
              role="alert"
            >
              {signOutError}
            </p>
          ) : null}
        </header>

        {error && documents.length === 0 ? (
          <section className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-4 py-5 text-sm text-[var(--muted)] sm:px-5">
            {error}
          </section>
        ) : (
          <DocumentListClient documents={documents} userId={userId} />
        )}
      </main>

      {signOutPhase === "confirm-discard" ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          role="alertdialog"
          aria-describedby="discard-drafts-description"
          aria-labelledby="discard-drafts-title"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-6 shadow-xl">
            <h2
              id="discard-drafts-title"
              className="text-lg font-semibold text-[var(--ink)]"
            >
              Unsaved drafts could not sync
            </h2>
            <p
              id="discard-drafts-description"
              className="mt-3 text-sm leading-6 text-[var(--muted)]"
            >
              {unsavedDraftCount}{" "}
              {unsavedDraftCount === 1 ? "draft is" : "drafts are"} still stored
              only on this device. Discarding will permanently remove{" "}
              {unsavedDraftCount === 1 ? "it" : "them"}.
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                autoFocus
                onClick={cancelDiscard}
                className="rounded-xl border border-[var(--line)] px-4 py-2.5 text-sm text-[var(--ink)]"
              >
                Keep me signed in
              </button>
              <button
                type="button"
                onClick={() => {
                  void finishSignOut();
                }}
                disabled={isBusy}
                className="rounded-xl bg-[#9b2d34] px-4 py-2.5 text-sm text-white disabled:opacity-60"
              >
                Discard drafts and sign out
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </PullToRefresh>
  );
}
