import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthPersistenceLifecycle } from "@/components/pwa/auth-persistence";

function createActions() {
  return {
    activateOwner: vi.fn(async () => undefined),
    clearNavigationCache: vi.fn(async () => undefined),
    clearUserId: vi.fn(),
    deactivateOwner: vi.fn(async () => undefined),
    redirectToAuth: vi.fn(),
    setUserId: vi.fn(),
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("auth persistence lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("quarantines the active owner's cache on an unexpected sign-out", async () => {
    const actions = createActions();
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);

    lifecycle.handleAuthEvent("SIGNED_OUT", null);

    expect(actions.clearUserId).toHaveBeenCalledOnce();
    expect(actions.deactivateOwner).toHaveBeenCalledWith("owner-a");
    expect(actions.clearNavigationCache).toHaveBeenCalledOnce();
    expect(actions.activateOwner).not.toHaveBeenCalled();

    await flushPromises();

    expect(actions.redirectToAuth).toHaveBeenCalledOnce();
  });

  it("does nothing when the initial session read fails transiently", async () => {
    const actions = createActions();
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);
    const version = lifecycle.captureVersion();

    lifecycle.applySessionCheck(null, new Error("network unavailable"), version);
    await flushPromises();

    expect(actions.clearUserId).not.toHaveBeenCalled();
    expect(actions.deactivateOwner).not.toHaveBeenCalled();
    expect(actions.clearNavigationCache).not.toHaveBeenCalled();
    expect(actions.redirectToAuth).not.toHaveBeenCalled();
  });

  it("ignores a stale session result after a newer auth event", async () => {
    const actions = createActions();
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);
    const sessionCheckVersion = lifecycle.captureVersion();

    lifecycle.handleAuthEvent("TOKEN_REFRESHED", "owner-a");
    lifecycle.applySessionCheck(null, null, sessionCheckVersion);
    await flushPromises();

    expect(actions.setUserId).toHaveBeenCalledWith("owner-a");
    expect(actions.activateOwner).toHaveBeenCalledWith("owner-a");
    expect(actions.clearUserId).not.toHaveBeenCalled();
    expect(actions.deactivateOwner).not.toHaveBeenCalled();
  });

  it("deactivates the previous owner before exposing a different owner", async () => {
    const actions = createActions();
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);

    lifecycle.handleAuthEvent("SIGNED_IN", "owner-b");
    await flushPromises();

    expect(actions.deactivateOwner).toHaveBeenCalledWith("owner-a");
    expect(actions.clearNavigationCache).toHaveBeenCalledOnce();
    expect(actions.setUserId).toHaveBeenCalledWith("owner-b");
    expect(actions.activateOwner).toHaveBeenCalledWith("owner-b");
  });

  it("does not redirect for a stale sign-out followed by reauthentication", async () => {
    let finishDeactivation: (() => void) | undefined;
    const actions = createActions();
    actions.deactivateOwner.mockReturnValue(
      new Promise<undefined>((resolve) => {
        finishDeactivation = () => resolve(undefined);
      }),
    );
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);

    lifecycle.handleAuthEvent("SIGNED_OUT", null);
    lifecycle.handleAuthEvent("SIGNED_IN", "owner-a");
    finishDeactivation?.();
    await flushPromises();

    expect(actions.activateOwner).toHaveBeenCalledWith("owner-a");
    expect(actions.redirectToAuth).not.toHaveBeenCalled();
  });

  it("suppresses pending redirects after the component is disposed", async () => {
    let finishDeactivation: (() => void) | undefined;
    const actions = createActions();
    actions.deactivateOwner.mockReturnValue(
      new Promise<undefined>((resolve) => {
        finishDeactivation = () => resolve(undefined);
      }),
    );
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);

    lifecycle.handleAuthEvent("SIGNED_OUT", null);
    lifecycle.dispose();
    finishDeactivation?.();
    await flushPromises();

    expect(actions.redirectToAuth).not.toHaveBeenCalled();
  });
});
