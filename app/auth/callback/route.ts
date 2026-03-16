import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

const DEFAULT_ERROR_MESSAGE = "Unable to complete sign-in. Please request a new magic link.";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const nextParam = requestUrl.searchParams.get("next");

  const nextPath =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : "/";

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      const authUrl = new URL("/auth", requestUrl.origin);
      authUrl.searchParams.set("next", nextPath);
      authUrl.searchParams.set("error", error.message?.trim() || DEFAULT_ERROR_MESSAGE);
      return NextResponse.redirect(authUrl);
    }
  }

  return NextResponse.redirect(new URL(nextPath, requestUrl.origin));
}
