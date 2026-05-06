"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  buildAuthRedirectPath,
  normalizeInternalPathFormValue,
  resolveAppOriginFromHeaders,
} from "@/lib/app-url";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const DEFAULT_ERROR_MESSAGE = "Unable to send magic link. Please try again.";

export async function requestMagicLinkAction(formData: FormData) {
  const nextPath = normalizeInternalPathFormValue(formData.get("nextPath"));
  const emailValue = formData.get("email");

  if (typeof emailValue !== "string" || emailValue.trim().length === 0) {
    redirect(
      buildAuthRedirectPath(nextPath, {
        error: "Enter a valid email address.",
      }),
    );
  }

  const email = emailValue.trim();
  const headersList = await headers();
  const redirectOrigin = resolveAppOriginFromHeaders(headersList);

  if (!redirectOrigin) {
    redirect(
      buildAuthRedirectPath(nextPath, {
        error: DEFAULT_ERROR_MESSAGE,
      }),
    );
  }

  const emailRedirectTo = `${redirectOrigin}/auth/confirm?next=${encodeURIComponent(nextPath)}`;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo,
    },
  });

  if (error) {
    const message = error.message?.trim() || DEFAULT_ERROR_MESSAGE;
    redirect(
      buildAuthRedirectPath(nextPath, {
        error: message.slice(0, 200),
      }),
    );
  }

  redirect(
    buildAuthRedirectPath(nextPath, {
      sent: "1",
    }),
  );
}
