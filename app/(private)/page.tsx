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

  if (!session?.user?.id) {
    redirect("/auth?next=/");
  }

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, updated_at")
    .eq("owner", session.user.id)
    .order("updated_at", { ascending: false });

  return (
    <DocumentsPageClient
      initialUserId={session.user.id}
      initialDocuments={(data ?? []) as CachedDocumentListItem[]}
      initialError={error?.message ?? null}
    />
  );
}
