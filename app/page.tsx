import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";

import { createSupabaseServerClient } from "@/lib/supabase/server";

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
    <main className="mx-auto min-h-screen w-full max-w-[880px] px-6 py-12">
      <header className="mb-10 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-[var(--font-writing)] text-4xl font-semibold tracking-tight text-[var(--ink)]">
            Documents
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">{user.email}</p>
        </div>

        <div className="flex items-center gap-2">
          <form action={createDocumentAction}>
            <button
              type="submit"
              className="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-95"
            >
              New Document
            </button>
          </form>

          <form action={signOutAction}>
            <button
              type="submit"
              className="rounded-xl bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--muted)] transition hover:text-[var(--accent)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="space-y-2">
        {documents && documents.length > 0 ? (
          documents.map((doc) => (
            <Link
              key={doc.id}
              href={`/doc/${doc.id}`}
              className="group flex items-center justify-between rounded-2xl bg-[var(--paper)] px-5 py-4 transition hover:shadow-[0_8px_22px_rgba(41,60,68,0.08)]"
            >
              <p className="line-clamp-1 pr-4 font-[var(--font-writing)] text-xl text-[var(--ink)]">
                {doc.title || "Untitled"}
              </p>
              <p className="shrink-0 text-xs text-[var(--muted)]">
                {formatDistanceToNow(new Date(doc.updated_at), {
                  addSuffix: true,
                })}
              </p>
            </Link>
          ))
        ) : (
          <div className="rounded-2xl px-6 py-12 text-center text-[var(--muted)]">
            No documents yet. Start with “New Document”.
          </div>
        )}
      </section>
    </main>
  );
}
