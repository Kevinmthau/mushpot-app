import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DocumentListClient } from "@/components/documents/document-list-client";
import PullToRefresh from "@/components/pull-to-refresh";

export const dynamic = "force-dynamic";

async function signOutAction() {
  "use server";

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/auth");
}

export default async function DocumentsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth");
  }

  const { data: documents, error } = await supabase
    .from("documents")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (
    <PullToRefresh>
      <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-8 sm:px-6 sm:py-12">
        <header className="mb-6 flex items-center justify-end sm:mb-10">
          <form action={signOutAction}>
            <button
              type="submit"
              className="rounded-xl bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--muted)] transition hover:text-[var(--accent)]"
            >
              Sign out
            </button>
          </form>
        </header>

        <DocumentListClient
          serverDocuments={documents ?? []}
          userId={user.id}
        />
      </main>
    </PullToRefresh>
  );
}
