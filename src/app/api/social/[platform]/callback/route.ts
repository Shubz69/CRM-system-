import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { jsonError, requirePermission } from "@/lib/session";
import { getSocialProviderAdapter } from "@/adapters/social";
import { parseSocialPlatformSlug } from "@/lib/social-platform";
import { verifyOAuthState } from "@/lib/social-oauth-state";
import { upsertSocialConnection } from "@/services/social-connections";
import { writeAuditLog } from "@/services/audit";

type Params = { params: Promise<{ platform: string }> };

function appUrl(): string {
  const env = getEnv();
  return (env.APP_URL || env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
}

function redirectToIntegrations(message: { error?: string; connected?: string }) {
  const url = new URL(`${appUrl()}/integrations`);
  if (message.error) url.searchParams.set("social_error", message.error);
  if (message.connected) url.searchParams.set("social_connected", message.connected);
  return NextResponse.redirect(url);
}

/** GET /api/social/[platform]/callback — completes the OAuth flow and stores the connection. */
export async function GET(req: NextRequest, { params }: Params) {
  const { platform: slug } = await params;
  const platform = parseSocialPlatformSlug(slug);
  if (!platform) return jsonError("Unknown social platform", 404);

  const searchParams = req.nextUrl.searchParams;
  const providerError = searchParams.get("error_description") || searchParams.get("error");
  if (providerError) {
    return redirectToIntegrations({ error: `${slug}: ${providerError}` });
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) {
    return redirectToIntegrations({ error: `${slug}: missing code/state from provider` });
  }

  const statePayload = verifyOAuthState(state);
  if (!statePayload || statePayload.platform !== slug) {
    return redirectToIntegrations({ error: `${slug}: connection request expired or was invalid — try again` });
  }

  let session: Awaited<ReturnType<typeof requirePermission>>;
  try {
    session = await requirePermission("integrations:manage");
  } catch {
    return NextResponse.redirect(`${appUrl()}/login`);
  }
  // Defence in depth: the session completing the callback must be the same
  // organisation/user that started it — never trust the OAuth state alone.
  if (
    statePayload.organisationId !== session.organisationId ||
    statePayload.userId !== session.userId
  ) {
    return redirectToIntegrations({ error: `${slug}: connection could not be verified — try again` });
  }

  const adapter = getSocialProviderAdapter(platform);
  try {
    const result = await adapter.exchangeCode(code);
    await upsertSocialConnection({
      organisationId: session.organisationId,
      platform,
      externalAccountId: result.externalAccountId,
      displayName: result.displayName,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresInSeconds: result.expiresInSeconds,
      scopes: result.scopes,
      capabilities: adapter.capabilities,
      connectedByUserId: session.userId,
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "social_connection.connected",
      entityType: "SocialConnection",
      entityId: `${slug}:${result.externalAccountId}`,
    });
    return redirectToIntegrations({ connected: slug });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    return redirectToIntegrations({ error: `${slug}: ${message}` });
  }
}
