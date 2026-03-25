import { PrivateStartupSlot } from "@/components/pwa/private-startup-slot";

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
