import { SocialPlatform } from "@prisma/client";
import { getEnv } from "@/lib/env";
import { safeFetch } from "@/lib/safe-fetch";
import type {
  ExchangeCodeResult,
  PublishContent,
  PublishResult,
  SocialCapabilities,
  SocialProviderAdapter,
} from "./types";
import { SocialNotConfiguredError, SocialOAuthError } from "./types";

/**
 * LinkedIn's free, self-serve consumer API. Scoped deliberately narrow:
 *  - openid, profile → identify the connecting member
 *  - w_member_social → post to THAT MEMBER'S OWN feed only
 *
 * No LinkedIn scope here reaches messaging or company-page posting — those
 * require LinkedIn's enterprise Marketing Developer Platform (slow/costly
 * partner approval) and are a deliberate business decision, not something
 * this adapter silently attempts. See docs/SOCIAL_CONNECTIONS.md.
 */
const SCOPES = ["openid", "profile", "w_member_social"];

function isConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REDIRECT_URI);
}

function requireConfig() {
  const env = getEnv();
  if (!isConfigured()) {
    throw new SocialNotConfiguredError(SocialPlatform.LINKEDIN);
  }
  return {
    clientId: env.LINKEDIN_CLIENT_ID!,
    clientSecret: env.LINKEDIN_CLIENT_SECRET!,
    redirectUri: env.LINKEDIN_REDIRECT_URI!,
  };
}

function getAuthorizeUrl(state: string): string {
  const { clientId, redirectUri } = requireConfig();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES.join(" "),
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

async function exchangeCode(code: string): Promise<ExchangeCodeResult> {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const tokenJson = (await tokenRes.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error_description?: string;
  } | null;
  if (!tokenRes.ok || !tokenJson?.access_token) {
    throw new SocialOAuthError(
      SocialPlatform.LINKEDIN,
      tokenJson?.error_description || `LinkedIn token exchange failed (HTTP ${tokenRes.status})`,
    );
  }

  const meRes = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const meJson = (await meRes.json().catch(() => null)) as {
    sub?: string;
    name?: string;
  } | null;
  if (!meRes.ok || !meJson?.sub) {
    throw new SocialOAuthError(SocialPlatform.LINKEDIN, "Could not resolve the LinkedIn member id");
  }

  return {
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    expiresInSeconds: tokenJson.expires_in,
    externalAccountId: meJson.sub,
    displayName: meJson.name,
    scopes: SCOPES,
  };
}

/**
 * Posts to the connecting member's own feed only (w_member_social has no
 * company-page reach). Media (image/video) goes through LinkedIn's
 * register-upload → binary PUT → ugcPosts flow.
 */
async function publish(
  accessToken: string,
  externalAccountId: string,
  content: PublishContent,
): Promise<PublishResult> {
  const authorUrn = `urn:li:person:${externalAccountId}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "X-Restli-Protocol-Version": "2.0.0",
  };

  const recipe =
    content.mediaType === "VIDEO"
      ? "urn:li:digitalmediaRecipe:feedshare-video"
      : "urn:li:digitalmediaRecipe:feedshare-image";

  const registerRes = await fetch("https://api.linkedin.com/v2/assets?action=registerUpload", {
    method: "POST",
    headers,
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: [recipe],
        owner: authorUrn,
        serviceRelationships: [
          { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
        ],
      },
    }),
  });
  const registerJson = (await registerRes.json().catch(() => null)) as {
    value?: {
      asset?: string;
      uploadMechanism?: {
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"?: { uploadUrl?: string };
      };
    };
    message?: string;
  } | null;
  const uploadUrl =
    registerJson?.value?.uploadMechanism?.[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ]?.uploadUrl;
  const asset = registerJson?.value?.asset;
  if (!registerRes.ok || !uploadUrl || !asset) {
    return { ok: false, error: registerJson?.message || "Failed to register LinkedIn media upload" };
  }

  const mediaFileRes = await safeFetch(content.mediaUrl);
  if (!mediaFileRes.ok) {
    return { ok: false, error: `Could not fetch media from ${content.mediaUrl}` };
  }
  const mediaBuffer = await mediaFileRes.arrayBuffer();
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: mediaBuffer,
  });
  if (!uploadRes.ok) {
    return { ok: false, error: `LinkedIn media upload failed (HTTP ${uploadRes.status})` };
  }

  const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: content.caption || "" },
          shareMediaCategory: content.mediaType,
          media: [{ status: "READY", media: asset }],
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  const postJson = (await postRes.json().catch(() => null)) as {
    id?: string;
    message?: string;
  } | null;
  if (!postRes.ok) {
    return { ok: false, error: postJson?.message || `LinkedIn post failed (HTTP ${postRes.status})` };
  }

  return { ok: true, externalPostId: postJson?.id || postRes.headers.get("x-restli-id") || undefined };
}

const capabilities: SocialCapabilities = { listen: true, publish: true, message: false };

export const linkedInSocialAdapter: SocialProviderAdapter = {
  platform: SocialPlatform.LINKEDIN,
  displayName: "LinkedIn",
  capabilities,
  isConfigured,
  getAuthorizeUrl,
  exchangeCode,
  publish,
};
