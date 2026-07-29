"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  buildAuthRedirectPath,
  normalizeInternalPathFormValue,
  resolveAppOriginFromHeaders,
} from "@/lib/app-url";
import {
  CAPTCHA_CONFIGURATION_ERROR_MESSAGE,
  CAPTCHA_REQUIRED_ERROR_MESSAGE,
  getCaptchaConfiguration,
  normalizeCaptchaToken,
} from "@/lib/auth-captcha";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const DEFAULT_ERROR_MESSAGE = "Unable to send magic link. Please try again.";
const RATE_LIMIT_ERROR_MESSAGE =
  "Too many sign-in emails were requested. Wait a while, then try again. If you already have a recent email, use the newest link.";

function getMagicLinkErrorMessage(error: {
  message?: string;
  code?: string;
  status?: number;
}) {
  const message = error.message?.trim() ?? "";
  const code = error.code?.trim() ?? "";

  if (
    error.status === 429 ||
    code === "over_email_send_rate_limit" ||
    message.toLowerCase().includes("rate limit")
  ) {
    return RATE_LIMIT_ERROR_MESSAGE;
  }

  return message || DEFAULT_ERROR_MESSAGE;
}

export async function requestMagicLinkAction(formData: FormData) {
  const nextPath = normalizeInternalPathFormValue(formData.get("nextPath"));
  const emailValue = formData.get("email");
  const captchaToken = normalizeCaptchaToken(formData.get("captchaToken"));
  const captchaConfiguration = getCaptchaConfiguration();

  if (captchaConfiguration.configurationError) {
    redirect(
      buildAuthRedirectPath(nextPath, {
        error: CAPTCHA_CONFIGURATION_ERROR_MESSAGE,
      }),
    );
  }

  if (captchaConfiguration.required && !captchaToken) {
    redirect(
      buildAuthRedirectPath(nextPath, {
        error: CAPTCHA_REQUIRED_ERROR_MESSAGE,
      }),
    );
  }

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

  const emailRedirectTo = `${redirectOrigin}/auth/verify?next=${encodeURIComponent(nextPath)}`;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo,
      ...(captchaToken ? { captchaToken } : {}),
    },
  });

  if (error) {
    const message = getMagicLinkErrorMessage(error);
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
