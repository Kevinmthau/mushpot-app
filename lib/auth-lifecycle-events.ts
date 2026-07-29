const EXPLICIT_SIGN_OUT_STARTED_EVENT =
  "mushpot:explicit-sign-out-started";
const AUTH_SESSION_RECOVERED_EVENT = "mushpot:auth-session-recovered";

type OwnerEventDetail = {
  owner: string;
};

function dispatchOwnerEvent(name: string, owner: string) {
  window.dispatchEvent(
    new CustomEvent<OwnerEventDetail>(name, {
      detail: { owner },
    }),
  );
}

export function announceExplicitSignOutStarted(owner: string) {
  dispatchOwnerEvent(EXPLICIT_SIGN_OUT_STARTED_EVENT, owner);
}

export function announceAuthSessionRecovered(owner: string) {
  dispatchOwnerEvent(AUTH_SESSION_RECOVERED_EVENT, owner);
}

export function subscribeToAuthLifecycleEvents(handlers: {
  onExplicitSignOutStarted: (owner: string) => void;
  onSessionRecovered: (owner: string) => void;
}) {
  const handleExplicitSignOutStarted = (event: Event) => {
    const owner = (event as CustomEvent<OwnerEventDetail>).detail?.owner;
    if (owner) {
      handlers.onExplicitSignOutStarted(owner);
    }
  };
  const handleSessionRecovered = (event: Event) => {
    const owner = (event as CustomEvent<OwnerEventDetail>).detail?.owner;
    if (owner) {
      handlers.onSessionRecovered(owner);
    }
  };

  window.addEventListener(
    EXPLICIT_SIGN_OUT_STARTED_EVENT,
    handleExplicitSignOutStarted,
  );
  window.addEventListener(
    AUTH_SESSION_RECOVERED_EVENT,
    handleSessionRecovered,
  );

  return () => {
    window.removeEventListener(
      EXPLICIT_SIGN_OUT_STARTED_EVENT,
      handleExplicitSignOutStarted,
    );
    window.removeEventListener(
      AUTH_SESSION_RECOVERED_EVENT,
      handleSessionRecovered,
    );
  };
}
