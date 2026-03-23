import { type NextRequest, NextResponse } from "next/server";

function requiresAuth(pathname: string) {
  return pathname === "/" || pathname.startsWith("/doc/");
}

function hasSessionCookie(request: NextRequest) {
  return request.cookies
    .getAll()
    .some(({ name }) => name.startsWith("sb-") && name.includes("auth-token"));
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (requiresAuth(pathname) && !hasSessionCookie(request)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/auth";
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return NextResponse.next({ request });
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files and images.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
