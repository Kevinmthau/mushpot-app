import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") || "/";

  if (!code) {
    const errorUrl = new URL("/auth", request.nextUrl.origin);
    errorUrl.searchParams.set("next", next);
    errorUrl.searchParams.set("error", "Missing authentication code.");
    return NextResponse.redirect(errorUrl);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const redirectUrl = new URL(next, request.nextUrl.origin);
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

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const errorUrl = new URL("/auth", request.nextUrl.origin);
    errorUrl.searchParams.set("next", next);
    errorUrl.searchParams.set(
      "error",
      "Sign-in link is invalid or has expired. Please request a new one.",
    );
    return NextResponse.redirect(errorUrl);
  }

  return response;
}
