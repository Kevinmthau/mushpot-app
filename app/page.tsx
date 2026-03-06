import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import PullToRefresh from "@/components/pull-to-refresh";

export const dynamic = "force-dynamic";

async function createDocumentAction() {
  "use server";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth");
  }

  const { data, error } = await supabase
    .from("documents")
    .insert({
      owner: user.id,
      title: "Untitled",
      content: "",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to create document.");
  }

  redirect(`/doc/${data.id}`);
}

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

        <section className="space-y-2">
          <form action={createDocumentAction}>
            <button
              type="submit"
              aria-label="New document"
              title="New document"
              className="group block w-full appearance-none rounded-2xl border-0 bg-transparent p-0 text-left transition hover:bg-[var(--paper)] hover:shadow-[0_8px_22px_rgba(41,60,68,0.08)]"
            >
              <div className="px-4 py-3 sm:px-5 sm:py-4">
                <p className="document-title-text line-clamp-1 text-[var(--muted)]">
                  New document...
                </p>
              </div>
            </button>
          </form>

          {documents?.map((doc) => (
            <Link
              key={doc.id}
              href={`/doc/${doc.id}`}
              className="group block rounded-2xl bg-[var(--paper)] px-4 py-3 transition hover:shadow-[0_8px_22px_rgba(41,60,68,0.08)] sm:px-5 sm:py-4"
            >
              <p className="document-title-text line-clamp-1 text-[var(--ink)]">
                {doc.title || "Untitled"}
              </p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {formatDistanceToNow(new Date(doc.updated_at), {
                  addSuffix: true,
                })}
              </p>
            </Link>
          ))}
        </section>
      </main>
    </PullToRefresh>
  );
}
