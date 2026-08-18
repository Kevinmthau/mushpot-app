import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import {
  buildAuthRedirectPath,
  PRIVATE_NEXT_PATH_HEADER,
} from "@/lib/app-url";
import type { Database } from "@/lib/supabase/types";

function requiresAuth(pathname: string) {
  return (
    pathname === "/" || pathname === "/doc" || pathname.startsWith("/doc/")
  );
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
  const shouldRefreshSession =
    isPrivateRequest || request.nextUrl.pathname === "/auth";

  if (!shouldRefreshSession) {
    return NextResponse.next();
  }

  const nextPath = isPrivateRequest ? getNextPath(request) : null;
  const responseHeaders = new Headers();
  const responseCookies: ResponseCookie[] = [];

  const applySupabaseResponseState = (response: NextResponse) => {
    responseCookies.forEach(({ name, value, options }) =>
      response.cookies.set(name, value, options),
    );
    responseHeaders.forEach((value, name) =>
      response.headers.set(name, value),
    );

    return response;
  };

  const createForwardResponse = () => {
    const requestHeaders = new Headers(request.headers);

    // The private redirect target is request context, never client input.
    requestHeaders.delete(PRIVATE_NEXT_PATH_HEADER);

    if (nextPath) {
      requestHeaders.set(PRIVATE_NEXT_PATH_HEADER, nextPath);
    }

    return applySupabaseResponseState(
      NextResponse.next({
        request: {
          headers: requestHeaders,
        },
      }),
    );
  };

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
        Object.entries(headers).forEach(([name, value]) => {
          responseHeaders.set(name, value);
        });
      },
    },
  });

  if (isPrivateRequest) {
    const { data, error } = await supabase.auth.getClaims();

    if (error || !data?.claims.sub) {
      const redirectUrl = new URL(
        buildAuthRedirectPath(nextPath ?? "/"),
        request.nextUrl.origin,
      );

      return applySupabaseResponseState(NextResponse.redirect(redirectUrl));
    }
  } else {
    // The auth page only needs refreshed cookies. Its server component owns
    // the trusted claims check and post-auth redirect behavior.
    await supabase.auth.getSession();
  }

  return createForwardResponse();
}

export const config = {
  matcher: ["/", "/doc/:path*", "/auth"],
};
