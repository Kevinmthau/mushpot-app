import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth/auth-form";
import { normalizeInternalPath } from "@/lib/app-url";
import { getCaptchaConfiguration } from "@/lib/auth-captcha";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type AuthPageProps = {
  searchParams: Promise<{ next?: string; sent?: string; error?: string }>;
};

export default async function AuthPage({ searchParams }: AuthPageProps) {
  const { next, sent, error } = await searchParams;
  const nextPath = normalizeInternalPath(next);
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();

  if (data?.claims.sub) {
    redirect(nextPath);
  }

  const message = sent === "1" ? "Check your email for a secure sign-in link." : null;
  const errorMessage = typeof error === "string" && error.length > 0 ? error : null;
  const captchaConfiguration = getCaptchaConfiguration();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] items-center px-4 py-10 sm:px-6 sm:py-20">
      <AuthForm
        nextPath={nextPath}
        message={message}
        error={errorMessage}
        turnstileSiteKey={captchaConfiguration.siteKey}
        captchaConfigurationError={captchaConfiguration.configurationError}
      />
    </main>
  );
}
