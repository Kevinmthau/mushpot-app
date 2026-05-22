import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { EmailOtpType } from "@supabase/supabase-js";

import {
  normalizeInternalPath,
  resolveAppOriginFromHeaders,
} from "@/lib/app-url";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = normalizeInternalPath(searchParams.get("next"));
  const appOrigin =
    resolveAppOriginFromHeaders(request.headers) ?? request.nextUrl.origin;

  if (!code && (!tokenHash || !type)) {
    const errorUrl = new URL("/auth", appOrigin);
    errorUrl.searchParams.set("next", next);
    errorUrl.searchParams.set("error", "Missing authentication code.");
    return NextResponse.redirect(errorUrl);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // Only allow post-auth redirects to internal app paths.
  const redirectUrl = new URL(next, appOrigin);
  if (redirectUrl.origin !== appOrigin) {
    return NextResponse.redirect(new URL("/", appOrigin));
  }
  const response = NextResponse.redirect(redirectUrl);

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({
        token_hash: tokenHash!,
        type: type!,
      });

  if (error) {
    console.error("[auth/confirm] exchangeCodeForSession failed:", error.message);
    const errorUrl = new URL("/auth", appOrigin);
    errorUrl.searchParams.set("next", next);
    errorUrl.searchParams.set(
      "error",
      "Sign-in link is invalid or has expired. Please request a new one.",
    );
    return NextResponse.redirect(errorUrl);
  }

  return response;
}
