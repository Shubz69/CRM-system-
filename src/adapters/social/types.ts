import type { SocialPlatform } from "@prisma/client";

/**
 * What a connected account on this platform can actually do, given today's
 * official APIs (checked against current platform docs, Aug 2026). This is
 * read by the Settings UI to render capability badges — never hardcode this
 * in the UI, read it from the adapter so it can't silently drift out of sync.
 */
export type SocialCapabilities = {
  listen: boolean;
  publish: boolean;
  message: boolean;
};

export type ExchangeCodeResult = {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the access token expires, if the provider reports one. */
  expiresInSeconds?: number;
  /** Platform-native account id (IG business account id / LinkedIn member URN / TikTok open_id). */
  externalAccountId: string;
  displayName?: string;
  scopes: string[];
};

export type RefreshResult = {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
};

export type PublishContent = {
  caption?: string;
  /** Publicly reachable URL to the image/video to publish. */
  mediaUrl: string;
  mediaType: "IMAGE" | "VIDEO";
};

export type PublishResult = {
  ok: boolean;
  externalPostId?: string;
  error?: string;
};

/**
 * One platform's OAuth + publish integration. Adapters must throw
 * SocialNotConfiguredError from isConfigured()-gated methods when their app
 * credentials env vars are missing — never fabricate a connection or a post.
 *
 * Messaging is intentionally NOT part of this interface. Instagram DMs stay
 * on the existing ManyChat channel (src/adapters/messaging); LinkedIn and
 * TikTok have no compliant third-party DM API at all, so there is nothing to
 * implement here for `message` — see docs/SOCIAL_CONNECTIONS.md.
 */
export type SocialProviderAdapter = {
  readonly platform: SocialPlatform;
  readonly displayName: string;
  readonly capabilities: SocialCapabilities;
  isConfigured(): boolean;
  getAuthorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<ExchangeCodeResult>;
  refreshAccessToken?(refreshToken: string): Promise<RefreshResult>;
  publish?(
    accessToken: string,
    externalAccountId: string,
    content: PublishContent,
  ): Promise<PublishResult>;
};

export class SocialNotConfiguredError extends Error {
  readonly code = "SOCIAL_NOT_CONFIGURED";
  constructor(
    readonly platform: SocialPlatform,
    message?: string,
  ) {
    super(
      message ||
        `${platform} app credentials are not configured. Set the required env vars — see docs/SOCIAL_CONNECTIONS.md.`,
    );
    this.name = "SocialNotConfiguredError";
  }
}

export class SocialOAuthError extends Error {
  readonly code = "SOCIAL_OAUTH_ERROR";
  constructor(
    readonly platform: SocialPlatform,
    message: string,
  ) {
    super(message);
    this.name = "SocialOAuthError";
  }
}
