import { PrivateStartupSlot } from "@/components/pwa/private-startup-slot";

export const dynamic = "force-dynamic";

export default function PrivateLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      {children}
      <PrivateStartupSlot />
    </>
  );
}
