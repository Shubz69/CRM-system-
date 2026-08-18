import { SocialPlatform } from "@prisma/client";
import { getEnv } from "@/lib/env";
import type {
  ExchangeCodeResult,
  PublishContent,
  PublishResult,
  RefreshResult,
  SocialCapabilities,
  SocialProviderAdapter,
} from "./types";
import { SocialNotConfiguredError, SocialOAuthError } from "./types";

/**
 * TikTok for Developers — Login Kit + Content Posting API (Direct Post).
 * No official TikTok DM API exists for third-party apps at all — nothing to
 * implement here for messaging. See docs/SOCIAL_CONNECTIONS.md.
 *
 * video.publish requires the app to move out of "unaudited" status (App
 * Review) before posts can go out as public; unaudited apps may only post
 * as private/self-view. user.info.basic just reads the profile for display.
 */
const SCOPES = ["user.info.basic", "video.publish"];

function isConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET && env.TIKTOK_REDIRECT_URI);
}

function requireConfig() {
  const env = getEnv();
  if (!isConfigured()) {
    throw new SocialNotConfiguredError(SocialPlatform.TIKTOK);
  }
  return {
    clientKey: env.TIKTOK_CLIENT_KEY!,
    clientSecret: env.TIKTOK_CLIENT_SECRET!,
    redirectUri: env.TIKTOK_REDIRECT_URI!,
  };
}

function getAuthorizeUrl(state: string): string {
  const { clientKey, redirectUri } = requireConfig();
  const params = new URLSearchParams({
    client_key: clientKey,
    scope: SCOPES.join(","),
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

async function exchangeCode(code: string): Promise<ExchangeCodeResult> {
  const { clientKey, clientSecret, redirectUri } = requireConfig();
  const form = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: form.toString(),
  });
  const tokenJson = (await tokenRes.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    open_id?: string;
    error_description?: string;
  } | null;
  if (!tokenRes.ok || !tokenJson?.access_token || !tokenJson.open_id) {
    throw new SocialOAuthError(
      SocialPlatform.TIKTOK,
      tokenJson?.error_description || `TikTok token exchange failed (HTTP ${tokenRes.status})`,
    );
  }

  const userRes = await fetch(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
    { headers: { Authorization: `Bearer ${tokenJson.access_token}` } },
  );
  const userJson = (await userRes.json().catch(() => null)) as {
    data?: { user?: { display_name?: string } };
  } | null;

  return {
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    expiresInSeconds: tokenJson.expires_in,
    externalAccountId: tokenJson.open_id,
    displayName: userJson?.data?.user?.display_name,
    scopes: SCOPES,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  const { clientKey, clientSecret } = requireConfig();
  const form = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  } | null;
  if (!res.ok || !json?.access_token) {
    throw new SocialOAuthError(
      SocialPlatform.TIKTOK,
      json?.error_description || `TikTok token refresh failed (HTTP ${res.status})`,
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSeconds: json.expires_in,
  };
}

/**
 * Content Posting API — Direct Post via PULL_FROM_URL. Requires the media
 * host domain to be verified in the TikTok developer portal for this app
 * (Direct Post → "Domain Verification"). Video only — TikTok's Content
 * Posting API does not accept static images for Direct Post.
 */
async function publish(
  accessToken: string,
  _externalAccountId: string,
  content: PublishContent,
): Promise<PublishResult> {
  if (content.mediaType !== "VIDEO") {
    return { ok: false, error: "TikTok Direct Post only accepts video content" };
  }
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_info: {
        title: content.caption || "",
        privacy_level: "SELF_ONLY",
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        video_url: content.mediaUrl,
      },
    }),
  });
  const json = (await res.json().catch(() => null)) as {
    data?: { publish_id?: string };
    error?: { message?: string; code?: string };
  } | null;
  if (!res.ok || json?.error?.code) {
    return { ok: false, error: json?.error?.message || `TikTok publish failed (HTTP ${res.status})` };
  }
  return { ok: true, externalPostId: json?.data?.publish_id };
}

const capabilities: SocialCapabilities = { listen: true, publish: true, message: false };

export const tiktokSocialAdapter: SocialProviderAdapter = {
  platform: SocialPlatform.TIKTOK,
  displayName: "TikTok",
  capabilities,
  isConfigured,
  getAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  publish,
};
