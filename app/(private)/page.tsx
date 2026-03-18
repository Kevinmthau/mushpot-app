import { redirect } from "next/navigation";

import { DocumentsPageClient } from "@/components/documents/documents-page-client";
import type { CachedDocumentListItem } from "@/lib/doc-cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user.id;

  if (!userId) {
    redirect("/auth?next=/");
  }

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, updated_at")
    .eq("owner", userId)
    .order("updated_at", { ascending: false });

  return (
    <DocumentsPageClient
      documents={(data ?? []) as CachedDocumentListItem[]}
      error={error?.message ?? null}
      userId={userId}
    />
  );
}
