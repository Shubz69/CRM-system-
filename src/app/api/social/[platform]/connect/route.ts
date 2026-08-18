import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { jsonError, requirePermission } from "@/lib/session";
import { getSocialProviderAdapter } from "@/adapters/social";
import { SocialNotConfiguredError } from "@/adapters/social/types";
import { parseSocialPlatformSlug } from "@/lib/social-platform";
import { createOAuthState } from "@/lib/social-oauth-state";

type Params = { params: Promise<{ platform: string }> };

function appUrl(): string {
  const env = getEnv();
  return (env.APP_URL || env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
}

/** GET /api/social/[platform]/connect — starts the OAuth flow, redirects to the provider. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { platform: slug } = await params;
  const platform = parseSocialPlatformSlug(slug);
  if (!platform) return jsonError("Unknown social platform", 404);

  let session: Awaited<ReturnType<typeof requirePermission>>;
  try {
    session = await requirePermission("integrations:manage");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return NextResponse.redirect(`${appUrl()}/login`);
    return jsonError(message, 403);
  }

  const adapter = getSocialProviderAdapter(platform);
  try {
    const state = createOAuthState({
      organisationId: session.organisationId,
      userId: session.userId,
      platform: slug,
    });
    const authorizeUrl = adapter.getAuthorizeUrl(state);
    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    const message =
      error instanceof SocialNotConfiguredError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not start the connection";
    return NextResponse.redirect(`${appUrl()}/integrations?social_error=${encodeURIComponent(message)}`);
  }
}
