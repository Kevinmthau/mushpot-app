import { type NextRequest, NextResponse } from "next/server";

import {
  buildAuthRedirectPath,
  PRIVATE_NEXT_PATH_HEADER,
} from "@/lib/app-url";

function requiresAuth(pathname: string) {
  return pathname === "/" || pathname.startsWith("/doc/");
}

function hasSessionCookie(request: NextRequest) {
  return request.cookies
    .getAll()
    .some(({ name }) => name.startsWith("sb-") && name.includes("auth-token"));
}

function getNextPath(request: NextRequest) {
  return `${request.nextUrl.pathname}${request.nextUrl.search}`;
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (!requiresAuth(pathname)) {
    return NextResponse.next({ request });
  }

  const nextPath = getNextPath(request);

  if (!hasSessionCookie(request)) {
    const redirectUrl = new URL(
      buildAuthRedirectPath(nextPath),
      request.nextUrl.origin,
    );
    return NextResponse.redirect(redirectUrl);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PRIVATE_NEXT_PATH_HEADER, nextPath);

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files and images.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
