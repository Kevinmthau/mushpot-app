"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      return;
    }

    if (!("serviceWorker" in navigator)) {
      return;
    }

    const scheduleUpdate = (registration: ServiceWorkerRegistration) => {
      const update = () => {
        void registration.update().catch(() => {
          // Best-effort freshness check.
        });
      };

      const idleWindow = window as Window & {
        requestIdleCallback?: (
          callback: IdleRequestCallback,
          options?: IdleRequestOptions,
        ) => number;
        cancelIdleCallback?: (handle: number) => void;
      };

      if (typeof idleWindow.requestIdleCallback === "function") {
        const handle = idleWindow.requestIdleCallback(update, { timeout: 15000 });
        return () => {
          idleWindow.cancelIdleCallback?.(handle);
        };
      }

      const timeoutId = globalThis.setTimeout(update, 10000);
      return () => {
        globalThis.clearTimeout(timeoutId);
      };
    };

    let cancelScheduledUpdate: (() => void) | undefined;

    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        cancelScheduledUpdate = scheduleUpdate(registration);
      })
      .catch((error) => {
        console.error("Service worker registration failed", error);
      });

    return () => {
      cancelScheduledUpdate?.();
    };
  }, []);

  return null;
}
