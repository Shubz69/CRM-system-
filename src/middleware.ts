import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_AUTH_PATHS = ["/login", "/account/change-password"];

function withPathname(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const hasSession = Boolean(
    request.cookies.get("next-auth.session-token")?.value ||
      request.cookies.get("__Secure-next-auth.session-token")?.value,
  );

  if (!hasSession) {
    const login = new URL("/login", request.url);
    login.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(login);
  }

  const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;

  // Force password change before other gated surfaces
  if (!PUBLIC_AUTH_PATHS.some((p) => pathname.startsWith(p)) && !pathname.startsWith("/api")) {
    const token = await getToken({ req: request, secret }).catch(() => null);
    if (token?.mustChangePassword) {
      return NextResponse.redirect(new URL("/account/change-password", request.url));
    }
  }

  // Protect /admin — require authenticated session; role gated here and in page
  if (pathname.startsWith("/admin")) {
    const token = await getToken({ req: request, secret });
    if (!token) {
      const login = new URL("/login", request.url);
      login.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(login);
    }
    const isAdmin =
      token.isPlatformAdmin === true ||
      token.role === "SUPER_ADMIN" ||
      token.role === "OWNER";
    if (!isAdmin) {
      return NextResponse.redirect(new URL("/ask", request.url));
    }
  }

  return withPathname(request);
}

export const config = {
  matcher: [
    "/ask/:path*",
    "/dashboard/:path*",
    "/inbox/:path*",
    "/pipeline/:path*",
    "/contacts/:path*",
    "/knowledge/:path*",
    "/agent/:path*",
    "/ai-agent/:path*",
    "/insights/:path*",
    "/automations/:path*",
    "/qualification/:path*",
    "/reports/:path*",
    "/simulator/:path*",
    "/settings/:path*",
    "/integrations/:path*",
    "/admin/:path*",
    "/account/:path*",
    "/attention/:path*",
    "/autopilot/:path*",
    "/setup/:path*",
  ],
};
