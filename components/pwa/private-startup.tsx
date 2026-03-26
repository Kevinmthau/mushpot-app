"use client";

import { AuthPersistence } from "@/components/pwa/auth-persistence";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { SyncManager } from "@/components/pwa/sync-manager";

export function PrivateStartup() {
  return (
    <>
      <AuthPersistence />
      <SyncManager />
      <ServiceWorkerRegister />
    </>
  );
}
