import { redirect } from "next/navigation";

import { DocumentsPageClient } from "@/components/documents/documents-page-client";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user?.id) {
    redirect("/auth?next=/");
  }

  return <DocumentsPageClient initialUserId={session.user.id} />;
}
