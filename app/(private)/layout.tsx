import { redirect } from "next/navigation";

import { PrivateStartupSlot } from "@/components/pwa/private-startup-slot";
import { PrivateSessionProvider } from "@/components/pwa/private-session-provider";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PrivateLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user?.id) {
    redirect("/auth");
  }

  return (
    <PrivateSessionProvider initialUserId={session.user.id}>
      {children}
      <PrivateStartupSlot />
    </PrivateSessionProvider>
  );
}
