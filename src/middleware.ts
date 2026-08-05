import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const hasSession = Boolean(
    request.cookies.get("next-auth.session-token")?.value ||
      request.cookies.get("__Secure-next-auth.session-token")?.value,
  );
  if (!hasSession) {
    const login = new URL("/login", request.url);
    login.searchParams.set("callbackUrl", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/inbox/:path*", "/pipeline/:path*", "/contacts/:path*", "/knowledge/:path*", "/agent/:path*", "/insights/:path*", "/automations/:path*", "/qualification/:path*", "/reports/:path*", "/simulator/:path*", "/settings/:path*"],
};
