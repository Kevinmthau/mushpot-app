"use client";

import type { ComponentType } from "react";
import { useEffect, useState } from "react";

const STARTUP_SLOT_IDLE_TIMEOUT_MS = 5000;
const STARTUP_SLOT_FALLBACK_DELAY_MS = 2500;

let privateStartupModulePromise:
  | Promise<typeof import("@/components/pwa/private-startup")>
  | null = null;
let resolvedPrivateStartup: ComponentType | null = null;

function preloadPrivateStartup() {
  if (!privateStartupModulePromise) {
    privateStartupModulePromise = import("@/components/pwa/private-startup")
      .then((module) => {
        resolvedPrivateStartup = module.PrivateStartup;
        return module;
      })
      .catch((error) => {
        privateStartupModulePromise = null;
        throw error;
      });
  }

  return privateStartupModulePromise;
}

export function PrivateStartupSlot() {
  const [LoadedPrivateStartup, setLoadedPrivateStartup] = useState<ComponentType | null>(
    () => resolvedPrivateStartup,
  );

  useEffect(() => {
    if (LoadedPrivateStartup) {
      return;
    }

    let isActive = true;
    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    const loadPrivateStartup = () => {
      void preloadPrivateStartup()
        .then((module) => {
          if (isActive) {
            setLoadedPrivateStartup(() => module.PrivateStartup);
          }
        })
        .catch(() => {
          // Keep startup features disabled if the lazy bundle fails.
        });
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      const handle = idleWindow.requestIdleCallback(loadPrivateStartup, {
        timeout: STARTUP_SLOT_IDLE_TIMEOUT_MS,
      });

      return () => {
        isActive = false;
        idleWindow.cancelIdleCallback?.(handle);
      };
    }

    const timeoutId = window.setTimeout(loadPrivateStartup, STARTUP_SLOT_FALLBACK_DELAY_MS);

    return () => {
      isActive = false;
      window.clearTimeout(timeoutId);
    };
  }, [LoadedPrivateStartup]);

  if (!LoadedPrivateStartup) {
    return null;
  }

  return <LoadedPrivateStartup />;
}
