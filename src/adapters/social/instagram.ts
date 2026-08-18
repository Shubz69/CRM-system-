import { SocialPlatform } from "@prisma/client";
import { getEnv } from "@/lib/env";
import type {
  ExchangeCodeResult,
  PublishContent,
  PublishResult,
  SocialCapabilities,
  SocialProviderAdapter,
} from "./types";
import { SocialNotConfiguredError, SocialOAuthError } from "./types";

/**
 * Instagram API with Instagram Login (Meta's direct-to-Instagram OAuth —
 * no Facebook Page required). Requires a Meta App with the "Instagram" product
 * added, Meta Business verification, and App Review at Advanced Access before
 * it will work for any account other than the app's own testers. See
 * docs/SOCIAL_CONNECTIONS.md for the exact setup steps.
 *
 * Scopes requested:
 *  - instagram_business_basic        → profile read (required base scope)
 *  - instagram_business_content_publish → publish() below
 * Messaging (instagram_business_manage_messages) is intentionally NOT
 * requested here — DMs stay on the existing ManyChat channel
 * (src/adapters/messaging). Wiring native IG messaging as an alternative to
 * ManyChat is a deliberate future upgrade, not part of this adapter.
 */
const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

function isConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET && env.INSTAGRAM_REDIRECT_URI);
}

function requireConfig() {
  const env = getEnv();
  if (!isConfigured()) {
    throw new SocialNotConfiguredError(SocialPlatform.INSTAGRAM);
  }
  return {
    appId: env.INSTAGRAM_APP_ID!,
    appSecret: env.INSTAGRAM_APP_SECRET!,
    redirectUri: env.INSTAGRAM_REDIRECT_URI!,
    apiVersion: env.INSTAGRAM_GRAPH_API_VERSION,
  };
}

function getAuthorizeUrl(state: string): string {
  const { appId, redirectUri } = requireConfig();
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(","),
    response_type: "code",
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

async function exchangeCode(code: string): Promise<ExchangeCodeResult> {
  const { appId, appSecret, redirectUri, apiVersion } = requireConfig();

  // Step 1: short-lived token.
  const tokenForm = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const tokenRes = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenForm.toString(),
  });
  const tokenJson = (await tokenRes.json().catch(() => null)) as {
    access_token?: string;
    user_id?: string;
    error_message?: string;
  } | null;
  if (!tokenRes.ok || !tokenJson?.access_token) {
    throw new SocialOAuthError(
      SocialPlatform.INSTAGRAM,
      tokenJson?.error_message || `Instagram token exchange failed (HTTP ${tokenRes.status})`,
    );
  }

  // Step 2: exchange for a long-lived token (~60 days, refreshable).
  const longLivedParams = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: appSecret,
    access_token: tokenJson.access_token,
  });
  const longLivedRes = await fetch(
    `https://graph.instagram.com/access_token?${longLivedParams.toString()}`,
  );
  const longLivedJson = (await longLivedRes.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  const accessToken = longLivedJson?.access_token || tokenJson.access_token;
  const expiresInSeconds = longLivedJson?.expires_in;

  // Step 3: resolve the connected account's id/username for display + storage.
  const meRes = await fetch(
    `https://graph.instagram.com/${apiVersion}/me?fields=id,username&access_token=${encodeURIComponent(accessToken)}`,
  );
  const meJson = (await meRes.json().catch(() => null)) as {
    id?: string;
    username?: string;
  } | null;

  return {
    accessToken,
    expiresInSeconds,
    externalAccountId: meJson?.id || tokenJson.user_id || "unknown",
    displayName: meJson?.username ? `@${meJson.username}` : undefined,
    scopes: SCOPES,
  };
}

/**
 * Content Publishing API — two-step container/publish flow. Works for
 * Business/Creator accounts once instagram_business_content_publish is
 * granted at Advanced Access. Video posts publish as Reels.
 */
async function publish(
  accessToken: string,
  externalAccountId: string,
  content: PublishContent,
): Promise<PublishResult> {
  const { apiVersion } = requireConfig();
  const containerParams = new URLSearchParams({
    access_token: accessToken,
    caption: content.caption || "",
  });
  if (content.mediaType === "VIDEO") {
    containerParams.set("media_type", "REELS");
    containerParams.set("video_url", content.mediaUrl);
  } else {
    containerParams.set("image_url", content.mediaUrl);
  }

  const containerRes = await fetch(
    `https://graph.instagram.com/${apiVersion}/${externalAccountId}/media`,
    { method: "POST", body: containerParams },
  );
  const containerJson = (await containerRes.json().catch(() => null)) as {
    id?: string;
    error?: { message?: string };
  } | null;
  if (!containerRes.ok || !containerJson?.id) {
    return { ok: false, error: containerJson?.error?.message || "Failed to create media container" };
  }

  const publishParams = new URLSearchParams({
    access_token: accessToken,
    creation_id: containerJson.id,
  });
  const publishRes = await fetch(
    `https://graph.instagram.com/${apiVersion}/${externalAccountId}/media_publish`,
    { method: "POST", body: publishParams },
  );
  const publishJson = (await publishRes.json().catch(() => null)) as {
    id?: string;
    error?: { message?: string };
  } | null;
  if (!publishRes.ok || !publishJson?.id) {
    return { ok: false, error: publishJson?.error?.message || "Failed to publish media" };
  }

  return { ok: true, externalPostId: publishJson.id };
}

const capabilities: SocialCapabilities = { listen: true, publish: true, message: false };

export const instagramSocialAdapter: SocialProviderAdapter = {
  platform: SocialPlatform.INSTAGRAM,
  displayName: "Instagram",
  capabilities,
  isConfigured,
  getAuthorizeUrl,
  exchangeCode,
  publish,
};
