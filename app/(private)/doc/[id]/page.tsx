import { redirect } from "next/navigation";

import { DocumentPageClient } from "@/components/editor/document-page-client";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type DocPageProps = {
  params: Promise<{ id: string }>;
};

export default async function DocumentEditorPage({ params }: DocPageProps) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user.id;

  if (!userId) {
    redirect(`/auth?next=/doc/${id}`);
  }

  return <DocumentPageClient documentId={id} userId={userId} />;
}
