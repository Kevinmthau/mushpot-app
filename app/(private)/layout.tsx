import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { PrivateStartupSlot } from "@/components/pwa/private-startup-slot";
import { PrivateSessionProvider } from "@/components/pwa/private-session-provider";
import {
  buildAuthRedirectPath,
  PRIVATE_NEXT_PATH_HEADER,
} from "@/lib/app-url";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PrivateLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headersList = await headers();
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user?.id) {
    redirect(
      buildAuthRedirectPath(headersList.get(PRIVATE_NEXT_PATH_HEADER) ?? "/"),
    );
  }

  return (
    <PrivateSessionProvider initialUserId={session.user.id}>
      {children}
      <PrivateStartupSlot />
    </PrivateSessionProvider>
  );
}
