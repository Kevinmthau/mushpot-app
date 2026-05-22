"use server";

import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import {
  buildAuthRedirectPath,
  normalizeInternalPathFormValue,
} from "@/lib/app-url";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const INVALID_LINK_MESSAGE =
  "Sign-in link is invalid or has expired. Please request a new one.";

const EMAIL_OTP_TYPES = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

function normalizeEmailOtpType(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return null;
  }

  return EMAIL_OTP_TYPES.has(value as EmailOtpType) ? (value as EmailOtpType) : null;
}

export async function verifyEmailLinkAction(formData: FormData) {
  const nextPath = normalizeInternalPathFormValue(formData.get("nextPath"));
  const tokenHash = formData.get("tokenHash");
  const type = normalizeEmailOtpType(formData.get("type"));

  if (typeof tokenHash !== "string" || tokenHash.length === 0 || !type) {
    redirect(buildAuthRedirectPath(nextPath, { error: INVALID_LINK_MESSAGE }));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type,
  });

  if (error) {
    console.error("[auth/verify] verifyOtp failed:", error.message);
    redirect(buildAuthRedirectPath(nextPath, { error: INVALID_LINK_MESSAGE }));
  }

  redirect(nextPath);
}
