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

  it("handles INITIAL_SESSION as the authoritative initial auth event", async () => {
    const actions = createActions();
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);
    const staleSessionCheckVersion = lifecycle.captureVersion();

    lifecycle.handleAuthEvent("INITIAL_SESSION", "owner-a");
    lifecycle.applySessionCheck(null, null, staleSessionCheckVersion);
    await flushPromises();

    expect(actions.setUserId).toHaveBeenCalledWith("owner-a");
    expect(actions.activateOwner).toHaveBeenCalledWith("owner-a");
    expect(actions.clearUserId).not.toHaveBeenCalled();
    expect(actions.deactivateOwner).not.toHaveBeenCalled();
  });

  it("treats an empty INITIAL_SESSION as signed out", async () => {
    const actions = createActions();
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);

    lifecycle.handleAuthEvent("INITIAL_SESSION", null);
    await flushPromises();

    expect(actions.clearUserId).toHaveBeenCalledOnce();
    expect(actions.deactivateOwner).toHaveBeenCalledWith("owner-a");
    expect(actions.redirectToAuth).toHaveBeenCalledOnce();
  });

  it("hides and deactivates the previous owner before exposing a different owner", async () => {
    let finishDeactivation: (() => void) | undefined;
    const actions = createActions();
    actions.deactivateOwner.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        finishDeactivation = () => resolve(undefined);
      }),
    );
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);

    lifecycle.handleAuthEvent("SIGNED_IN", "owner-b");

    expect(actions.clearUserId).toHaveBeenCalledOnce();
    expect(actions.deactivateOwner).toHaveBeenCalledWith("owner-a");
    expect(actions.setUserId).not.toHaveBeenCalledWith("owner-b");
    expect(actions.activateOwner).not.toHaveBeenCalledWith("owner-b");

    finishDeactivation?.();
    await flushPromises();

    expect(actions.clearNavigationCache).toHaveBeenCalledOnce();
    expect(actions.setUserId).toHaveBeenCalledWith("owner-b");
    expect(actions.activateOwner).toHaveBeenCalledWith("owner-b");
  });

  it("undoes a next-owner activation when sign-out wins the race", async () => {
    let finishActivation: (() => void) | undefined;
    const actions = createActions();
    actions.activateOwner.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishActivation = () => resolve(undefined);
        }),
    );
    const lifecycle = createAuthPersistenceLifecycle("owner-a", actions);

    lifecycle.handleAuthEvent("SIGNED_IN", "owner-b");
    await flushPromises();
    expect(actions.activateOwner).toHaveBeenCalledWith("owner-b");

    lifecycle.handleAuthEvent("SIGNED_OUT", null);
    finishActivation?.();
    await flushPromises();

    expect(actions.setUserId).not.toHaveBeenCalledWith("owner-b");
    expect(actions.deactivateOwner).toHaveBeenCalledWith("owner-b");
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
