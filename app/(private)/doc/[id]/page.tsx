import Link from "next/link";
import { redirect } from "next/navigation";

import { DocumentPageClient } from "@/components/editor/document-page-client";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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

  const { data: document, error } = await supabase
    .from("documents")
    .select("id, owner, title, content, updated_at, share_enabled, share_token")
    .eq("id", id)
    .eq("owner", userId)
    .maybeSingle();

  if (!document) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-[800px] px-4 py-12 sm:px-5">
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-5 py-6">
          <h1 className="font-[var(--font-writing)] text-2xl text-[var(--ink)]">
            {error ? "Unable to load document" : "Document not found"}
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {error
              ? error.message
              : "It may have been deleted or you may not have access to it."}
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white"
          >
            Back to documents
          </Link>
        </div>
      </main>
    );
  }

  return <DocumentPageClient initialDocument={document} />;
}
