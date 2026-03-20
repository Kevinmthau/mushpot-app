"use client";

import { useEffect, useState } from "react";

import { AuthPersistence } from "@/components/pwa/auth-persistence";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { SyncManager } from "@/components/pwa/sync-manager";

const STARTUP_IDLE_TIMEOUT_MS = 2000;
const STARTUP_FALLBACK_DELAY_MS = 800;

export function PrivateStartup() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      const handle = idleWindow.requestIdleCallback(() => {
        setIsReady(true);
      }, { timeout: STARTUP_IDLE_TIMEOUT_MS });

      return () => {
        idleWindow.cancelIdleCallback?.(handle);
      };
    }

    const timeoutId = window.setTimeout(() => {
      setIsReady(true);
    }, STARTUP_FALLBACK_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  if (!isReady) {
    return null;
  }

  return (
    <>
      <AuthPersistence />
      <SyncManager />
      <ServiceWorkerRegister />
    </>
  );
}
