import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import {
  buildAuthRedirectPath,
  PRIVATE_NEXT_PATH_HEADER,
} from "@/lib/app-url";
import type { Database } from "@/lib/supabase/types";

function requiresAuth(pathname: string) {
  return pathname === "/" || pathname.startsWith("/doc/");
}

function getNextPath(request: NextRequest) {
  return `${request.nextUrl.pathname}${request.nextUrl.search}`;
}

type ResponseCookie = {
  name: string;
  value: string;
  options: CookieOptions;
};

function getSupabaseConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
    );
  }

  return { supabaseAnonKey, supabaseUrl };
}

export async function proxy(request: NextRequest) {
  const isPrivateRequest = requiresAuth(request.nextUrl.pathname);
  const nextPath = isPrivateRequest ? getNextPath(request) : null;
  const responseHeaders = new Headers();
  const responseCookies: ResponseCookie[] = [];

  const createForwardResponse = () => {
    const requestHeaders = new Headers(request.headers);

    if (nextPath) {
      requestHeaders.set(PRIVATE_NEXT_PATH_HEADER, nextPath);
    }

    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
  };

  let supabaseResponse = createForwardResponse();
  const { supabaseAnonKey, supabaseUrl } = getSupabaseConfig();
  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        responseCookies.push(...cookiesToSet);
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );

        supabaseResponse = createForwardResponse();

        responseCookies.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
        Object.entries(headers).forEach(([name, value]) => {
          responseHeaders.set(name, value);
          supabaseResponse.headers.set(name, value);
        });
      },
    },
  });

  const { data } = await supabase.auth.getClaims();

  if (isPrivateRequest && !data?.claims.sub) {
    const redirectUrl = new URL(
      buildAuthRedirectPath(nextPath ?? "/"),
      request.nextUrl.origin,
    );
    const redirectResponse = NextResponse.redirect(redirectUrl);

    responseCookies.forEach(({ name, value, options }) =>
      redirectResponse.cookies.set(name, value, options),
    );
    responseHeaders.forEach((value, name) =>
      redirectResponse.headers.set(name, value),
    );

    return redirectResponse;
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
