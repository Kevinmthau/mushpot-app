import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

function requiresAuth(pathname: string) {
  return pathname === "/" || pathname.startsWith("/doc/");
}

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const pathname = request.nextUrl.pathname;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return supabaseResponse;
  }

  // Skip session refresh for the PKCE callback route. The /auth/confirm
  // route handler needs the code-verifier cookie intact. Calling getUser()
  // here when there is no valid session causes the SDK to clear auth
  // cookies (including the verifier) before the route handler can read them.
  if (pathname === "/auth/confirm") {
    return supabaseResponse;
  }

  // When a PKCE auth flow is in progress (e.g. after requesting a magic
  // link but before the user clicks it), a code-verifier cookie exists.
  // Calling getUser() with no active session causes the SDK to clear all
  // auth cookies via setAll — destroying the verifier. Skip the session
  // refresh entirely while a PKCE flow is pending; the verifier will be
  // consumed by /auth/confirm when the user completes sign-in.
  const hasPendingPKCE = request.cookies
    .getAll()
    .some((cookie) => cookie.name.includes("code-verifier"));

  if (!hasPendingPKCE) {
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    });

    await supabase.auth.getUser();
  }

  // Redirect unauthenticated users to sign-in for protected routes.
  if (requiresAuth(pathname)) {
    const hasSession = request.cookies
      .getAll()
      .some(({ name }) => name.startsWith("sb-") && name.includes("auth-token"));

    if (!hasSession) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/auth";
      redirectUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(redirectUrl);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files and images.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
