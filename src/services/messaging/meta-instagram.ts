import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { IntegrationType, Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { assertMetaInstagramMessagingConfigured, getEnv, META_INSTAGRAM_DEV_VERIFY_TOKEN } from "@/lib/env";
import { createOAuthState, verifyOAuthState } from "@/lib/social-oauth-state";
import { writeAuditLog } from "@/services/audit";
import {
  META_INSTAGRAM_MESSAGING_SCOPES,
  META_INSTAGRAM_OAUTH_PURPOSE,
  META_INSTAGRAM_WEBHOOK_FIELDS,
  MESSAGING_PROVIDER,
} from "@/services/messaging/providers";

const ACCESS_TOKEN_KEY = "access_token";
const STATE_TTL_MS = 10 * 60 * 1000;

export type MetaInstagramHealthStatus =
  | "CONNECTED"
  | "DEGRADED"
  | "REAUTH_REQUIRED"
  | "DISCONNECTED"
  | "NOT_CONFIGURED";

export type MetaInstagramConnectionView = {
  configured: boolean;
  isActive: boolean;
  health: MetaInstagramHealthStatus;
  username: string | null;
  igUserId: string | null;
  scopes: string[];
  webhookSubscribed: boolean;
  connectedAt: string | null;
  lastValidatedAt: string | null;
  /** Never includes token. */
  duplicateManyChatRisk: boolean;
};

function resolveMetaAppConfig() {
  const env = getEnv();
  const creds = resolveMetaAppCredentials();
  const apiVersion = resolveMetaGraphApiVersion(env.INSTAGRAM_GRAPH_API_VERSION);
  const redirectUri =
    env.META_INSTAGRAM_MESSAGING_REDIRECT_URI ||
    (env.APP_URL
      ? `${env.APP_URL.replace(/\/$/, "")}/api/integrations/meta-instagram/callback`
      : undefined);
  return {
    appId: creds.appId,
    appSecret: creds.appSecret,
    apiVersion,
    redirectUri,
    verifyToken: env.META_INSTAGRAM_WEBHOOK_VERIFY_TOKEN,
  };
}

/** Explicit supported default for native Meta Instagram (Aug 2026). Never fall back to v21.0. */
export const DEFAULT_META_GRAPH_API_VERSION = "v26.0";

/**
 * Central Graph API version for Instagram Login messaging (OAuth, send, subscribe, validate).
 * Configurable via INSTAGRAM_GRAPH_API_VERSION; empty/invalid → DEFAULT_META_GRAPH_API_VERSION.
 */
export function resolveMetaGraphApiVersion(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_META_GRAPH_API_VERSION;
  const normalized = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  if (!/^v\d+(\.\d+)?$/.test(normalized)) return DEFAULT_META_GRAPH_API_VERSION;
  return normalized;
}

export function isMetaInstagramAppConfigured(): boolean {
  const { appId, appSecret, redirectUri } = resolveMetaAppConfig();
  return Boolean(appId && appSecret && redirectUri);
}

export function getMetaGraphVersion(): string {
  return resolveMetaAppConfig().apiVersion;
}

/** Resolve Meta app credentials with explicit INSTAGRAM_* > META_* precedence. */
export function resolveMetaAppCredentials(): {
  appId: string | undefined;
  appSecret: string | undefined;
  source: "INSTAGRAM_*" | "META_*" | "none";
} {
  const env = getEnv();
  if (env.INSTAGRAM_APP_ID?.trim() && env.INSTAGRAM_APP_SECRET?.trim()) {
    return {
      appId: env.INSTAGRAM_APP_ID.trim(),
      appSecret: env.INSTAGRAM_APP_SECRET.trim(),
      source: "INSTAGRAM_*",
    };
  }
  if (env.INSTAGRAM_APP_ID?.trim() || env.INSTAGRAM_APP_SECRET?.trim()) {
    // Partial INSTAGRAM_* still wins for the set half; other half may come from META alias.
    return {
      appId: (env.INSTAGRAM_APP_ID || env.META_APP_ID || "").trim() || undefined,
      appSecret: (env.INSTAGRAM_APP_SECRET || env.META_APP_SECRET || "").trim() || undefined,
      source: "INSTAGRAM_*",
    };
  }
  if (env.META_APP_ID?.trim() || env.META_APP_SECRET?.trim()) {
    return {
      appId: env.META_APP_ID?.trim() || undefined,
      appSecret: env.META_APP_SECRET?.trim() || undefined,
      source: "META_*",
    };
  }
  return { appId: undefined, appSecret: undefined, source: "none" };
}

function asConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function hasRequiredScopes(scopes: string[]): boolean {
  return META_INSTAGRAM_MESSAGING_SCOPES.every((s) => scopes.includes(s));
}

async function getIntegration(organisationId: string) {
  return prisma.integration.findUnique({
    where: {
      organisationId_type_name: {
        organisationId,
        type: IntegrationType.META_INSTAGRAM,
        name: "default",
      },
    },
    include: { credentials: true },
  });
}

async function decryptAccessToken(integrationId: string): Promise<{
  token: string | null;
  credentialId: string | null;
  healthStatus: string | null;
}> {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      integrationId_keyName: { integrationId, keyName: ACCESS_TOKEN_KEY },
    },
  });
  if (!credential) return { token: null, credentialId: null, healthStatus: null };
  if (credential.healthStatus === "REVOKED") {
    return { token: null, credentialId: credential.id, healthStatus: "REVOKED" };
  }
  try {
    return {
      token: decryptSecret(credential.encryptedValue),
      credentialId: credential.id,
      healthStatus: credential.healthStatus,
    };
  } catch {
    return { token: null, credentialId: credential.id, healthStatus: "ERROR" };
  }
}

export async function createMetaInstagramOAuthState(input: {
  organisationId: string;
  userId: string;
}): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  await prisma.oAuthStateConsumption.create({
    data: {
      nonce,
      organisationId: input.organisationId,
      purpose: META_INSTAGRAM_OAUTH_PURPOSE,
      userId: input.userId,
      expiresAt,
    },
  });
  return createOAuthState({
    organisationId: input.organisationId,
    userId: input.userId,
    platform: `${META_INSTAGRAM_OAUTH_PURPOSE}:${nonce}`,
  });
}

export async function consumeMetaInstagramOAuthState(state: string): Promise<{
  organisationId: string;
  userId: string;
  nonce: string;
} | null> {
  const payload = verifyOAuthState(state);
  if (!payload) return null;
  const [purpose, nonce] = payload.platform.split(":");
  if (purpose !== META_INSTAGRAM_OAUTH_PURPOSE || !nonce) return null;

  const row = await prisma.oAuthStateConsumption.findUnique({ where: { nonce } });
  if (!row) return null;
  if (row.consumedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  if (row.organisationId !== payload.organisationId) return null;
  if (row.purpose !== META_INSTAGRAM_OAUTH_PURPOSE) return null;

  try {
    await prisma.oAuthStateConsumption.update({
      where: { nonce },
      data: { consumedAt: new Date() },
    });
  } catch {
    return null;
  }

  return {
    organisationId: payload.organisationId,
    userId: payload.userId,
    nonce,
  };
}

export function buildMetaInstagramAuthorizeUrl(state: string): string {
  const { appId, redirectUri } = resolveMetaAppConfig();
  if (!appId || !redirectUri) {
    throw new Error("Meta Instagram app is not configured");
  }
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: META_INSTAGRAM_MESSAGING_SCOPES.join(","),
    response_type: "code",
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

export async function exchangeMetaInstagramCode(code: string): Promise<{
  accessToken: string;
  expiresInSeconds?: number;
  igUserId: string;
  username?: string;
  scopes: string[];
}> {
  const { appId, appSecret, redirectUri, apiVersion } = resolveMetaAppConfig();
  if (!appId || !appSecret || !redirectUri) {
    throw new Error("Meta Instagram app is not configured");
  }

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
    user_id?: string | number;
    error_message?: string;
  } | null;
  if (!tokenRes.ok || !tokenJson?.access_token) {
    throw new Error(tokenJson?.error_message || `Token exchange failed (${tokenRes.status})`);
  }

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
    igUserId: String(meJson?.id || tokenJson.user_id || ""),
    username: meJson?.username,
    scopes: [...META_INSTAGRAM_MESSAGING_SCOPES],
  };
}

/**
 * Instagram Login long-lived token refresh (not Facebook Page tokens).
 * Requires a still-valid long-lived token. grant_type=ig_refresh_token.
 * On failure callers must surface REAUTH_REQUIRED — never pretend healthy.
 */
export async function refreshMetaInstagramLongLivedToken(
  accessToken: string,
): Promise<
  | { ok: true; accessToken: string; expiresInSeconds?: number }
  | { ok: false; error: string; reauthRequired: true }
> {
  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: accessToken,
  });
  try {
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?${params.toString()}`,
    );
    const json = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error?: { message?: string };
    } | null;
    if (!res.ok || !json?.access_token) {
      return {
        ok: false,
        error: json?.error?.message || `Instagram token refresh failed (${res.status})`,
        reauthRequired: true,
      };
    }
    return {
      ok: true,
      accessToken: json.access_token,
      expiresInSeconds: json.expires_in,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Instagram token refresh error",
      reauthRequired: true,
    };
  }
}

async function markMetaCredentialReauthRequired(
  organisationId: string,
  note: string,
): Promise<void> {
  await prisma.integrationCredential.updateMany({
    where: {
      integration: {
        organisationId,
        type: IntegrationType.META_INSTAGRAM,
        name: "default",
      },
      keyName: ACCESS_TOKEN_KEY,
    },
    data: { healthStatus: "EXPIRED", healthNote: note.slice(0, 200) },
  });
}

export async function subscribeMetaInstagramWebhooks(input: {
  igUserId: string;
  accessToken: string;
}): Promise<{ ok: boolean; error?: string }> {
  assertMetaInstagramMessagingConfigured();
  const { apiVersion } = resolveMetaAppConfig();
  const url = `https://graph.instagram.com/${apiVersion}/${encodeURIComponent(input.igUserId)}/subscribed_apps`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscribed_fields: META_INSTAGRAM_WEBHOOK_FIELDS.join(","),
      access_token: input.accessToken,
    }),
  });
  const raw = (await res.json().catch(() => null)) as { success?: boolean; error?: { message?: string } } | null;
  if (!res.ok || raw?.success === false) {
    return {
      ok: false,
      error: raw?.error?.message || `Webhook subscription failed (${res.status})`,
    };
  }
  return { ok: true };
}

/**
 * Persist Meta Instagram messaging connection after OAuth.
 * Rejects if another org already owns the same IG professional account.
 */
export async function completeMetaInstagramConnection(input: {
  organisationId: string;
  userId: string;
  accessToken: string;
  igUserId: string;
  username?: string;
  scopes: string[];
  expiresInSeconds?: number;
}): Promise<{ ok: true; webhookSubscribed: boolean } | { ok: false; error: string }> {
  if (!input.igUserId) return { ok: false, error: "Missing Instagram account id" };

  const conflict = await prisma.messagingChannel.findFirst({
    where: {
      provider: MESSAGING_PROVIDER.META_INSTAGRAM,
      externalId: input.igUserId,
      organisationId: { not: input.organisationId },
      isActive: true,
    },
    select: { organisationId: true },
  });
  if (conflict) {
    return { ok: false, error: "This Instagram account is already connected to another workspace" };
  }

  const manyChatDup = await prisma.messagingChannel.findFirst({
    where: {
      organisationId: input.organisationId,
      provider: MESSAGING_PROVIDER.MANYCHAT,
      isActive: true,
      OR: [
        { externalId: input.igUserId },
        { instagramUsername: input.username ?? undefined },
      ],
    },
    select: { id: true },
  });

  const subscription = await subscribeMetaInstagramWebhooks({
    igUserId: input.igUserId,
    accessToken: input.accessToken,
  });

  const expiresAt = input.expiresInSeconds
    ? new Date(Date.now() + input.expiresInSeconds * 1000)
    : null;
  const now = new Date();
  const config = {
    igUserId: input.igUserId,
    username: input.username ?? null,
    scopes: input.scopes,
    connectedAt: now.toISOString(),
    lastValidatedAt: now.toISOString(),
    expiresAt: expiresAt?.toISOString() ?? null,
    webhookSubscribed: subscription.ok,
    webhookSubscribeError: subscription.error ?? null,
    credentialSource: "instagram_login",
    duplicateManyChatRisk: Boolean(manyChatDup),
  };

  const integration = await prisma.integration.upsert({
    where: {
      organisationId_type_name: {
        organisationId: input.organisationId,
        type: IntegrationType.META_INSTAGRAM,
        name: "default",
      },
    },
    create: {
      organisationId: input.organisationId,
      type: IntegrationType.META_INSTAGRAM,
      name: "default",
      isActive: subscription.ok,
      config: config as Prisma.InputJsonValue,
    },
    update: {
      isActive: subscription.ok,
      config: config as Prisma.InputJsonValue,
    },
  });

  const encrypted = encryptSecret(input.accessToken);
  await prisma.integrationCredential.upsert({
    where: {
      integrationId_keyName: { integrationId: integration.id, keyName: ACCESS_TOKEN_KEY },
    },
    create: {
      integrationId: integration.id,
      keyName: ACCESS_TOKEN_KEY,
      encryptedValue: encrypted,
      healthStatus: "HEALTHY",
      lastVerifiedAt: now,
      lastRotatedAt: now,
    },
    update: {
      encryptedValue: encrypted,
      healthStatus: "HEALTHY",
      healthNote: null,
      lastVerifiedAt: now,
      lastRotatedAt: now,
    },
  });

  await prisma.messagingChannel.upsert({
    where: {
      organisationId_provider_externalId: {
        organisationId: input.organisationId,
        provider: MESSAGING_PROVIDER.META_INSTAGRAM,
        externalId: input.igUserId,
      },
    },
    create: {
      organisationId: input.organisationId,
      provider: MESSAGING_PROVIDER.META_INSTAGRAM,
      externalId: input.igUserId,
      displayName: input.username ? `@${input.username}` : "Instagram (Meta)",
      instagramUsername: input.username ?? null,
      isActive: subscription.ok,
      config: {
        webhookSubscribed: subscription.ok,
        connectedVia: "meta_instagram",
      } as Prisma.InputJsonValue,
    },
    update: {
      displayName: input.username ? `@${input.username}` : "Instagram (Meta)",
      instagramUsername: input.username ?? null,
      isActive: subscription.ok,
      config: {
        webhookSubscribed: subscription.ok,
        connectedVia: "meta_instagram",
      } as Prisma.InputJsonValue,
    },
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.userId,
    action: subscription.ok
      ? "integration.meta_instagram.connected"
      : "integration.meta_instagram.connect_incomplete",
    entityType: "Integration",
    entityId: integration.id,
    metadata: {
      igUserId: input.igUserId,
      username: input.username ?? null,
      webhookSubscribed: subscription.ok,
      scopes: input.scopes,
      duplicateManyChatRisk: Boolean(manyChatDup),
    },
  });

  if (!subscription.ok) {
    return {
      ok: false,
      error:
        subscription.error ||
        "Connected account but webhook subscription failed — reconnect after fixing Meta app webhooks",
    };
  }
  return { ok: true, webhookSubscribed: true };
}

export async function getMetaInstagramConnectionView(
  organisationId: string,
): Promise<MetaInstagramConnectionView> {
  if (!isMetaInstagramAppConfigured()) {
    return {
      configured: false,
      isActive: false,
      health: "NOT_CONFIGURED",
      username: null,
      igUserId: null,
      scopes: [],
      webhookSubscribed: false,
      connectedAt: null,
      lastValidatedAt: null,
      duplicateManyChatRisk: false,
    };
  }

  const integration = await getIntegration(organisationId);
  if (!integration) {
    return {
      configured: true,
      isActive: false,
      health: "DISCONNECTED",
      username: null,
      igUserId: null,
      scopes: [],
      webhookSubscribed: false,
      connectedAt: null,
      lastValidatedAt: null,
      duplicateManyChatRisk: false,
    };
  }

  const cfg = asConfig(integration.config);
  const scopes = Array.isArray(cfg.scopes) ? cfg.scopes.map(String) : [];
  const cred = await decryptAccessToken(integration.id);
  let health: MetaInstagramHealthStatus = "DISCONNECTED";
  if (!integration.isActive || cred.healthStatus === "REVOKED") health = "DISCONNECTED";
  else if (!cred.token) health = "REAUTH_REQUIRED";
  else if (!cfg.webhookSubscribed || !hasRequiredScopes(scopes)) health = "DEGRADED";
  else health = "CONNECTED";

  return {
    configured: true,
    isActive: integration.isActive,
    health,
    username: typeof cfg.username === "string" ? cfg.username : null,
    igUserId: typeof cfg.igUserId === "string" ? cfg.igUserId : null,
    scopes,
    webhookSubscribed: cfg.webhookSubscribed === true,
    connectedAt: typeof cfg.connectedAt === "string" ? cfg.connectedAt : null,
    lastValidatedAt: typeof cfg.lastValidatedAt === "string" ? cfg.lastValidatedAt : null,
    duplicateManyChatRisk: cfg.duplicateManyChatRisk === true,
  };
}

export async function resolveMetaInstagramSendCredential(organisationId: string): Promise<{
  token: string | null;
  connectionRef: string | null;
  source: "organisation" | "none" | "revoked";
  igUserId: string | null;
}> {
  const integration = await getIntegration(organisationId);
  if (!integration) return { token: null, connectionRef: null, source: "none", igUserId: null };
  const connectionRef = `meta_instagram:${integration.id}`;
  const cred = await decryptAccessToken(integration.id);
  const cfg = asConfig(integration.config);
  const igUserId = typeof cfg.igUserId === "string" ? cfg.igUserId : null;
  if (!integration.isActive || cred.healthStatus === "REVOKED") {
    return { token: null, connectionRef, source: "revoked", igUserId };
  }
  if (!cred.token) return { token: null, connectionRef, source: "none", igUserId };
  return { token: cred.token, connectionRef, source: "organisation", igUserId };
}

export async function validateMetaInstagramConnection(organisationId: string): Promise<{
  ok: boolean;
  status: string;
  detail: string;
  health: MetaInstagramHealthStatus;
}> {
  const view = await getMetaInstagramConnectionView(organisationId);
  if (view.health === "NOT_CONFIGURED") {
    return {
      ok: false,
      status: "Not configured",
      detail: "Meta Instagram app credentials are not set on the server.",
      health: view.health,
    };
  }
  if (view.health === "DISCONNECTED") {
    return {
      ok: false,
      status: "Disconnected",
      detail: "Instagram is not connected for this workspace.",
      health: view.health,
    };
  }

  const cred = await resolveMetaInstagramSendCredential(organisationId);
  if (!cred.token || !cred.igUserId) {
    return {
      ok: false,
      status: "Reconnect required",
      detail: "Saved credential is missing or revoked.",
      health: "REAUTH_REQUIRED",
    };
  }

  const { apiVersion } = resolveMetaAppConfig();
  const meRes = await fetch(
    `https://graph.instagram.com/${apiVersion}/me?fields=id,username&access_token=${encodeURIComponent(cred.token)}`,
  );
  if (!meRes.ok) {
    await markMetaCredentialReauthRequired(organisationId, `token_check_${meRes.status}`);
    return {
      ok: false,
      status: "Reconnect required",
      detail: "Instagram rejected the saved token.",
      health: "REAUTH_REQUIRED",
    };
  }

  // Instagram Login refresh requires a still-valid long-lived token.
  const refreshed = await refreshMetaInstagramLongLivedToken(cred.token);
  if (!refreshed.ok) {
    await markMetaCredentialReauthRequired(organisationId, refreshed.error);
    return {
      ok: false,
      status: "Reconnect required",
      detail: "Instagram token refresh failed — reconnect Instagram.",
      health: "REAUTH_REQUIRED",
    };
  }

  if (refreshed.accessToken !== cred.token) {
    const integration = await getIntegration(organisationId);
    if (integration) {
      const expiresAt = refreshed.expiresInSeconds
        ? new Date(Date.now() + refreshed.expiresInSeconds * 1000)
        : null;
      await prisma.integrationCredential.updateMany({
        where: { integrationId: integration.id, keyName: ACCESS_TOKEN_KEY },
        data: {
          encryptedValue: encryptSecret(refreshed.accessToken),
          healthStatus: "HEALTHY",
          healthNote: null,
          lastVerifiedAt: new Date(),
          lastRotatedAt: new Date(),
        },
      });
      const prev = asConfig(integration.config);
      await prisma.integration.update({
        where: { id: integration.id },
        data: {
          config: {
            ...prev,
            expiresAt: expiresAt?.toISOString() ?? prev.expiresAt ?? null,
            lastValidatedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  if (!hasRequiredScopes(view.scopes)) {
    return {
      ok: false,
      status: "Messaging permission missing",
      detail: "Reconnect and grant Instagram messaging permission.",
      health: "DEGRADED",
    };
  }
  if (!view.webhookSubscribed) {
    return {
      ok: false,
      status: "Webhook subscription incomplete",
      detail: "Account connected but Meta webhook fields are not subscribed.",
      health: "DEGRADED",
    };
  }

  await prisma.integration.updateMany({
    where: { organisationId, type: IntegrationType.META_INSTAGRAM, name: "default" },
    data: {
      config: {
        ...asConfig((await getIntegration(organisationId))?.config),
        lastValidatedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });

  return {
    ok: true,
    status: "Connected",
    detail: view.username ? `Connected as @${view.username}` : "Connected",
    health: "CONNECTED",
  };
}

export async function disconnectMetaInstagram(input: {
  organisationId: string;
  userId?: string | null;
}): Promise<void> {
  const integration = await getIntegration(input.organisationId);
  if (!integration) return;

  await prisma.integration.update({
    where: { id: integration.id },
    data: { isActive: false },
  });
  await prisma.integrationCredential.updateMany({
    where: { integrationId: integration.id, keyName: ACCESS_TOKEN_KEY },
    data: { healthStatus: "REVOKED", healthNote: "disconnected" },
  });
  await prisma.messagingChannel.updateMany({
    where: {
      organisationId: input.organisationId,
      provider: MESSAGING_PROVIDER.META_INSTAGRAM,
    },
    data: { isActive: false },
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.userId ?? null,
    action: "integration.meta_instagram.disconnected",
    entityType: "Integration",
    entityId: integration.id,
    metadata: {},
  });
}

/** Resolve organisation from Meta Instagram professional account id. Fail closed. */
export async function resolveOrganisationByMetaIgAccountId(
  igAccountId: string,
): Promise<{ organisationId: string; channelId: string } | null> {
  const channel = await prisma.messagingChannel.findFirst({
    where: {
      provider: MESSAGING_PROVIDER.META_INSTAGRAM,
      externalId: igAccountId,
      isActive: true,
    },
    select: { id: true, organisationId: true },
  });
  if (!channel) return null;
  const integration = await prisma.integration.findFirst({
    where: {
      organisationId: channel.organisationId,
      type: IntegrationType.META_INSTAGRAM,
      name: "default",
      isActive: true,
    },
    select: { id: true },
  });
  if (!integration) return null;
  return { organisationId: channel.organisationId, channelId: channel.id };
}

export function verifyMetaWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
}): boolean {
  const { appSecret } = resolveMetaAppConfig();
  if (!appSecret || !input.signatureHeader) return false;
  const expected = createHmac("sha256", appSecret).update(input.rawBody, "utf8").digest("hex");
  const provided = input.signatureHeader.replace(/^sha256=/i, "").trim();
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(provided, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyMetaWebhookChallenge(input: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
}): string | null {
  const { verifyToken } = resolveMetaAppConfig();
  if (!verifyToken) return null;
  // Never accept the development default as a production verify token.
  if (verifyToken === META_INSTAGRAM_DEV_VERIFY_TOKEN && process.env.NODE_ENV === "production") {
    return null;
  }
  if (input.mode !== "subscribe") return null;
  if (!input.token || !input.challenge) return null;
  const a = Buffer.from(input.token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return input.challenge;
}

export function hashMetaPayload(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
