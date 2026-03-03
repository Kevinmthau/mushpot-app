import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth/auth-form";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type AuthPageProps = {
  searchParams: Promise<{ next?: string }>;
};

export default async function AuthPage({ searchParams }: AuthPageProps) {
  const { next } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/");
  }

  const nextPath =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[460px] items-center px-6 py-20">
      <AuthForm nextPath={nextPath} />
    </main>
  );
}
