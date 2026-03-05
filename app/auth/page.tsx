import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth/auth-form";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type AuthPageProps = {
  searchParams: Promise<{ next?: string; sent?: string; error?: string }>;
};

export default async function AuthPage({ searchParams }: AuthPageProps) {
  const { next, sent, error } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/");
  }

  const nextPath =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const message = sent === "1" ? "Check your email for a secure sign-in link." : null;
  const errorMessage = typeof error === "string" && error.length > 0 ? error : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] items-center px-4 py-10 sm:px-6 sm:py-20">
      <AuthForm nextPath={nextPath} message={message} error={errorMessage} />
    </main>
  );
}
