import { describe, expect, it, vi } from "vitest";

import { completeCurrentDeviceSignOut } from "@/components/documents/documents-page-client";
import { createAuthPersistenceLifecycle } from "@/components/pwa/auth-persistence";

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

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
      getSessionOwner: vi.fn(async () => ({
        error: null,
        owner: null,
      })),
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

  it("keeps cached drafts when an error leaves the session signed in", async () => {
    const signOutError = new Error("Sign-out failed");
    const purgeOwnerCache = vi.fn(async () => undefined);
    const clearNavigationCache = vi.fn(async () => undefined);

    await expect(
      completeCurrentDeviceSignOut({
        clearNavigationCache,
        getSessionOwner: vi.fn(async () => ({
          error: null,
          owner: "owner-a",
        })),
        owner: "owner-a",
        purgeOwnerCache,
        signOut: vi.fn(async () => ({ error: signOutError })),
      }),
    ).resolves.toEqual({
      error: signOutError,
      status: "still-signed-in",
    });

    expect(purgeOwnerCache).not.toHaveBeenCalled();
    expect(clearNavigationCache).not.toHaveBeenCalled();
  });

  it("finishes cleanup when SIGNED_OUT fires before signOut returns an error", async () => {
    const calls: string[] = [];
    const signOutError = new Error("Remote revoke failed");
    const purgeOwnerCache = vi.fn(async () => {
      calls.push("purge");
    });
    const result = await completeCurrentDeviceSignOut({
      clearNavigationCache: vi.fn(async () => {
        calls.push("clear-navigation");
      }),
      getSessionOwner: vi.fn(async () => {
        calls.push("read-session");
        return {
          error: null,
          owner: null,
        };
      }),
      owner: "owner-a",
      purgeOwnerCache,
      signOut: vi.fn(async () => {
        calls.push("SIGNED_OUT");
        return { error: signOutError };
      }),
    });

    expect(calls.slice(0, 2)).toEqual(["SIGNED_OUT", "read-session"]);
    expect(purgeOwnerCache).toHaveBeenCalledWith("owner-a");
    expect(result).toEqual({
      error: signOutError,
      status: "signed-out",
    });
  });

  it("cancels a pending SIGNED_OUT redirect when session recovery confirms the owner", async () => {
    let finishDeactivation: (() => void) | undefined;
    const actions = {
      activateOwner: vi.fn(async () => undefined),
      clearNavigationCache: vi.fn(async () => undefined),
      clearUserId: vi.fn(),
      deactivateOwner: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishDeactivation = resolve;
          }),
      ),
      redirectToAuth: vi.fn(),
      setUserId: vi.fn(),
    };
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);
    lifecycle.beginExplicitSignOut("owner-a");

    const result = await completeCurrentDeviceSignOut({
      clearNavigationCache: vi.fn(async () => undefined),
      getSessionOwner: vi.fn(async () => ({
        error: null,
        owner: "owner-a",
      })),
      owner: "owner-a",
      purgeOwnerCache: vi.fn(async () => undefined),
      signOut: vi.fn(async () => {
        lifecycle.handleAuthEvent("SIGNED_OUT", null);
        return { error: new Error("Remote revoke failed") };
      }),
    });

    expect(result.status).toBe("still-signed-in");
    lifecycle.recoverSession("owner-a");
    finishDeactivation?.();
    await flushPromises();

    expect(actions.redirectToAuth).not.toHaveBeenCalled();
    expect(actions.activateOwner).toHaveBeenCalledWith("owner-a");
    expect(actions.setUserId).toHaveBeenCalledWith("owner-a");
  });

  it("quarantines rather than purges when session recovery is indeterminate", async () => {
    const sessionError = new Error("Session storage unavailable");
    const purgeOwnerCache = vi.fn(async () => undefined);
    const clearNavigationCache = vi.fn(async () => undefined);

    await expect(
      completeCurrentDeviceSignOut({
        clearNavigationCache,
        getSessionOwner: vi.fn(async () => ({
          error: sessionError,
          owner: null,
        })),
        owner: "owner-a",
        purgeOwnerCache,
        signOut: vi.fn(async () => ({
          error: new Error("Sign-out failed"),
        })),
      }),
    ).resolves.toEqual({
      error: sessionError,
      status: "indeterminate",
    });

    expect(purgeOwnerCache).not.toHaveBeenCalled();
    expect(clearNavigationCache).not.toHaveBeenCalled();
  });

  it("does not treat a replacement owner's session as signed out", async () => {
    const signOutError = new Error("Original session changed");
    const purgeOwnerCache = vi.fn(async () => undefined);

    await expect(
      completeCurrentDeviceSignOut({
        clearNavigationCache: vi.fn(async () => undefined),
        getSessionOwner: vi.fn(async () => ({
          error: null,
          owner: "owner-b",
        })),
        owner: "owner-a",
        purgeOwnerCache,
        signOut: vi.fn(async () => ({ error: signOutError })),
      }),
    ).resolves.toEqual({
      error: signOutError,
      owner: "owner-b",
      status: "session-changed",
    });

    expect(purgeOwnerCache).toHaveBeenCalledWith("owner-a");
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
      getSessionOwner: vi.fn(async () => ({
        error: null,
        owner: null,
      })),
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
