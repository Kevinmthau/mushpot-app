import { describe, expect, it, vi } from "vitest";

import { completeCurrentDeviceSignOut } from "@/components/documents/documents-page-client";

describe("completeCurrentDeviceSignOut", () => {
  it("uses local scope and purges only after sign-out succeeds", async () => {
    const calls: string[] = [];
    const signOut = vi.fn(async (options: { scope: "local" }) => {
      calls.push(`sign-out:${options.scope}`);
      return { error: null };
    });
    const purgeOwnerCache = vi.fn(async (owner: string) => {
      calls.push(`purge:${owner}`);
    });
    const clearNavigationCache = vi.fn(async () => {
      calls.push("clear-navigation");
    });

    await completeCurrentDeviceSignOut({
      clearNavigationCache,
      owner: "owner-a",
      purgeOwnerCache,
      signOut,
    });

    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(calls[0]).toBe("sign-out:local");
    expect(calls.slice(1).sort()).toEqual(
      ["clear-navigation", "purge:owner-a"].sort(),
    );
  });

  it("keeps cached drafts when Supabase reports a sign-out error", async () => {
    const signOutError = new Error("Sign-out failed");
    const purgeOwnerCache = vi.fn(async () => undefined);
    const clearNavigationCache = vi.fn(async () => undefined);

    await expect(
      completeCurrentDeviceSignOut({
        clearNavigationCache,
        owner: "owner-a",
        purgeOwnerCache,
        signOut: vi.fn(async () => ({ error: signOutError })),
      }),
    ).rejects.toBe(signOutError);

    expect(purgeOwnerCache).not.toHaveBeenCalled();
    expect(clearNavigationCache).not.toHaveBeenCalled();
  });

  it("waits for sign-out confirmation before starting destructive cleanup", async () => {
    let finishSignOut: (() => void) | undefined;
    const signOut = vi.fn(
      () =>
        new Promise<{ error: null }>((resolve) => {
          finishSignOut = () => resolve({ error: null });
        }),
    );
    const purgeOwnerCache = vi.fn(async () => undefined);
    const clearNavigationCache = vi.fn(async () => undefined);

    const completion = completeCurrentDeviceSignOut({
      clearNavigationCache,
      owner: "owner-a",
      purgeOwnerCache,
      signOut,
    });

    await Promise.resolve();
    expect(purgeOwnerCache).not.toHaveBeenCalled();
    expect(clearNavigationCache).not.toHaveBeenCalled();

    finishSignOut?.();
    await completion;

    expect(purgeOwnerCache).toHaveBeenCalledWith("owner-a");
    expect(clearNavigationCache).toHaveBeenCalledOnce();
  });
});
