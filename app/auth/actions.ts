"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const DEFAULT_ERROR_MESSAGE = "Unable to send magic link. Please try again.";

function normalizeNextPath(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return "/";
  }

  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function stripTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

function buildAuthRedirectPath(
  nextPath: string,
  params?: {
    error?: string;
    sent?: "1";
  },
) {
  const searchParams = new URLSearchParams({ next: nextPath });

  if (params?.error) {
    searchParams.set("error", params.error);
  }

  if (params?.sent) {
    searchParams.set("sent", params.sent);
  }

  return `/auth?${searchParams.toString()}`;
}

function buildRequestOriginFromHeaders(
  headersList: {
    get(name: string): string | null;
  },
  isLocalhost: boolean,
) {
  const forwardedHost = headersList.get("x-forwarded-host");
  const host = (forwardedHost ?? headersList.get("host") ?? "").split(",")[0]?.trim();

  if (!host) {
    return null;
  }

  const forwardedProto = headersList.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || (isLocalhost ? "http" : "https");

  return `${protocol}://${host}`;
}

export async function requestMagicLinkAction(formData: FormData) {
  const nextPath = normalizeNextPath(formData.get("nextPath"));
  const emailValue = formData.get("email");

  if (typeof emailValue !== "string" || emailValue.trim().length === 0) {
    redirect(
      buildAuthRedirectPath(nextPath, {
        error: "Enter a valid email address.",
      }),
    );
  }

  const email = emailValue.trim();
  const configuredAppUrl = stripTrailingSlashes(process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "");
  const headersList = await headers();
  const host = (headersList.get("x-forwarded-host") ?? headersList.get("host") ?? "")
    .split(",")[0]
    ?.trim();
  const hostname = host?.split(":")[0]?.toLowerCase() ?? "";
  const isLocalhost = LOCALHOST_HOSTNAMES.has(hostname);
  const requestOrigin = buildRequestOriginFromHeaders(headersList, isLocalhost);
  const redirectOrigin =
    isLocalhost && configuredAppUrl ? configuredAppUrl : requestOrigin ?? configuredAppUrl;

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
