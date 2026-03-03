import { notFound } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const dynamic = "force-dynamic";

type SharedDocPageProps = {
  params: Promise<{ id: string; token: string }>;
};

type SharedDoc = {
  title: string;
  content: string;
  updated_at: string;
};

async function fetchSharedDocument(id: string, token: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
    );
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/get-shared-doc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({ docId: id, token }),
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as SharedDoc;
}

export default async function SharedDocumentPage({ params }: SharedDocPageProps) {
  const { id, token } = await params;

  const document = await fetchSharedDocument(id, token);

  if (!document) {
    notFound();
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-[880px] px-6 py-10">
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-6 py-8 md:px-10 md:py-10">
        <header className="mb-8 border-b border-[var(--line)] pb-5">
          <h1 className="font-[var(--font-writing)] text-4xl font-semibold tracking-tight text-[var(--ink)]">
            {document.title || "Untitled"}
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Updated{" "}
            {formatDistanceToNow(new Date(document.updated_at), {
              addSuffix: true,
            })}
          </p>
        </header>

        <article className="markdown-body">
          <Markdown remarkPlugins={[remarkGfm]}>{document.content}</Markdown>
        </article>
      </div>
    </main>
  );
}
