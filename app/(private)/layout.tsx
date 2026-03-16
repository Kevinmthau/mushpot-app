import { AuthPersistence } from "@/components/pwa/auth-persistence";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { SyncManager } from "@/components/pwa/sync-manager";

export default function PrivateLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      {children}
      <AuthPersistence />
      <SyncManager />
      <ServiceWorkerRegister />
    </>
  );
}
