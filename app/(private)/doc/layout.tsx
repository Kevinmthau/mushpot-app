import { PrivateStartup } from "@/components/pwa/private-startup";

export default function DocumentRouteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      {children}
      <PrivateStartup />
    </>
  );
}
