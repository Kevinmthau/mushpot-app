import { notFound, redirect } from "next/navigation";

import { EditorClient } from "@/components/editor/editor-client";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type DocPageProps = {
  params: Promise<{ id: string }>;
};

export default async function DocumentEditorPage({ params }: DocPageProps) {
  const { id } = await params;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth");
  }

  const { data: document, error } = await supabase
    .from("documents")
    .select("id, title, content, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error || !document) {
    notFound();
  }

  return <EditorClient initialDocument={document} />;
}
