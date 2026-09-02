/**
 * Zernio adapter — validation / preferred low-cost social provider.
 * Master API key is SERVER ONLY. Never expose to browser clients.
 * Prospect discovery does NOT depend on this adapter.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/db";
import { recordSocialProviderUsage } from "@/services/social-prospecting/usage";
import type { SocialPlatformNetwork } from "@/services/social-prospecting/capabilities";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";

export type ZernioConnectedAccount = {
  accountId: string;
  platform: string;
  displayName?: string;
  username?: string;
  /** instagram_login | facebook_page | linkedin_personal | linkedin_organization | unknown */
  authMode?: string;
  status?: string;
  connectedAt?: string;
};

export function isZernioConfigured(): boolean {
  return Boolean(getEnv().ZERNIO_API_KEY?.trim());
}

export function isZernioWebhookConfigured(): boolean {
  return Boolean(getEnv().ZERNIO_WEBHOOK_SECRET?.trim());
}

export function assertZernioConfigured(): void {
  if (!isZernioConfigured()) {
    throw Object.assign(new Error("Zernio is not configured"), { code: "ZERNIO_NOT_CONFIGURED" });
  }
}

export function assertZernioWebhookConfigured(): void {
  if (!isZernioWebhookConfigured()) {
    throw Object.assign(new Error("Zernio webhook secret is not configured"), {
      code: "ZERNIO_NOT_CONFIGURED",
    });
  }
}

/** Signed, expiry-bound connect state — binds callback to the requesting organisation. */
export function createZernioConnectState(organisationId: string, ttlSeconds = 900): string {
  const secret = getEnv().AUTH_SECRET || getEnv().NEXTAUTH_SECRET || getEnv().ENCRYPTION_KEY;
  if (!secret) throw new Error("Cannot sign Zernio connect state without AUTH_SECRET");
  const payload = {
    orgId: organisationId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: createHmac("sha256", secret).update(`${organisationId}:${Date.now()}`).digest("hex").slice(0, 16),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyZernioConnectState(
  state: string | null | undefined,
  expectedOrganisationId: string,
): { ok: true } | { ok: false; code: string } {
  if (!state || !state.includes(".")) return { ok: false, code: "STATE_MISSING" };
  const secret = getEnv().AUTH_SECRET || getEnv().NEXTAUTH_SECRET || getEnv().ENCRYPTION_KEY;
  if (!secret) return { ok: false, code: "STATE_UNCONFIGURED" };
  const [body, sig] = state.split(".");
  if (!body || !sig) return { ok: false, code: "STATE_MALFORMED" };
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: "STATE_TAMPERED" };
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      orgId?: string;
      exp?: number;
    };
    if (!payload.orgId || payload.orgId !== expectedOrganisationId) {
      return { ok: false, code: "STATE_ORG_MISMATCH" };
    }
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, code: "STATE_EXPIRED" };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "STATE_MALFORMED" };
  }
}

/**
 * Resolve tenant only from stored ZernioProfile mapping.
 * Requires profileId; optionally verifies accountId belongs to that profile.
 * Never trusts a bare user-controlled org field.
 */
export async function resolveZernioWebhookTenant(input: {
  profileId?: string | null;
  accountId?: string | null;
}): Promise<
  | { ok: true; organisationId: string; zernioProfileId: string; accountBound: boolean }
  | { ok: false; code: "UNKNOWN_PROFILE" | "UNKNOWN_ACCOUNT" | "PROFILE_ACCOUNT_MISMATCH" }
> {
  if (!input.profileId) {
    if (input.accountId) {
      const hit = await findOrganisationIdByZernioAccountId(input.accountId);
      if (!hit) return { ok: false, code: "UNKNOWN_ACCOUNT" };
      // Account-only resolution is allowed only when the account was previously synced
      // into a stored ZernioProfile.connectedAccounts (not a free-form user field alone).
      const profile = await prisma.zernioProfile.findUnique({
        where: { organisationId: hit.organisationId },
      });
      if (!profile?.zernioProfileId) return { ok: false, code: "UNKNOWN_PROFILE" };
      return {
        ok: true,
        organisationId: hit.organisationId,
        zernioProfileId: profile.zernioProfileId,
        accountBound: true,
      };
    }
    return { ok: false, code: "UNKNOWN_PROFILE" };
  }

  const organisationId = await findOrganisationIdByZernioProfileId(input.profileId);
  if (!organisationId) return { ok: false, code: "UNKNOWN_PROFILE" };

  if (input.accountId) {
    const profile = await prisma.zernioProfile.findUnique({ where: { organisationId } });
    const accounts = Array.isArray(profile?.connectedAccounts)
      ? (profile!.connectedAccounts as ZernioConnectedAccount[])
      : [];
    if (accounts.length && !accounts.some((a) => a.accountId === input.accountId)) {
      // Soft allow when accounts not yet synced (first connect race), but require profile match.
      // Still never invent a different org.
      if (accounts.length > 0) return { ok: false, code: "PROFILE_ACCOUNT_MISMATCH" };
    }
  }

  return {
    ok: true,
    organisationId,
    zernioProfileId: input.profileId,
    accountBound: Boolean(input.accountId),
  };
}

function networkHealthFromAccounts(
  accounts: ZernioConnectedAccount[],
  platformNeedle: string,
): "NOT_CONFIGURED" | "CONNECTED" | "DEGRADED" | "REAUTH_REQUIRED" | "DISCONNECTED" {
  if (!isZernioConfigured()) return "NOT_CONFIGURED";
  const matches = accounts.filter((a) => String(a.platform).toLowerCase().includes(platformNeedle));
  if (matches.length === 0) return "DISCONNECTED";
  const statuses = matches.map((a) => String(a.status || "").toLowerCase());
  if (statuses.some((s) => s.includes("reauth") || s.includes("expired") || s === "needs_reauth")) {
    return "REAUTH_REQUIRED";
  }
  if (statuses.some((s) => s.includes("degraded") || s.includes("error") || s === "limited")) {
    return "DEGRADED";
  }
  if (statuses.every((s) => s.includes("disconnect") || s === "revoked" || s === "inactive")) {
    return "DISCONNECTED";
  }
  return "CONNECTED";
}

export function getZernioNetworkHealth(profile: {
  status: string;
  connectedAccounts: unknown;
  metadata?: unknown;
}): {
  overall: string;
  instagram: string;
  linkedin: string;
} {
  const accounts = Array.isArray(profile.connectedAccounts)
    ? (profile.connectedAccounts as ZernioConnectedAccount[])
    : [];
  const instagram = networkHealthFromAccounts(accounts, "instagram");
  const linkedin = networkHealthFromAccounts(accounts, "linkedin");
  const networkStates = [instagram, linkedin];
  let overall: string;
  if (!isZernioConfigured()) {
    overall = "NOT_CONFIGURED";
  } else if (profile.status === "DISCONNECTED" || networkStates.every((s) => s === "DISCONNECTED")) {
    overall = "DISCONNECTED";
  } else if (networkStates.some((s) => s === "REAUTH_REQUIRED") || profile.status === "REAUTH_REQUIRED") {
    overall = "REAUTH_REQUIRED";
  } else if (networkStates.some((s) => s === "DEGRADED") || profile.status === "DEGRADED") {
    overall = "DEGRADED";
  } else if (networkStates.some((s) => s === "CONNECTED")) {
    overall = "CONNECTED";
  } else {
    overall = "DISCONNECTED";
  }
  return { overall, instagram, linkedin };
}

function apiKey(): string {
  assertZernioConfigured();
  return getEnv().ZERNIO_API_KEY!.trim();
}

async function zernioFetch(
  path: string,
  init: RequestInit & { organisationId?: string; capability?: string; network?: string } = {},
): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; latencyMs: number }> {
  const started = Date.now();
  const { organisationId, capability, network, ...reqInit } = init;
  const res = await fetch(`${ZERNIO_API_BASE}${path}`, {
    ...reqInit,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
      ...(reqInit.headers || {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const latencyMs = Date.now() - started;
  if (organisationId && capability) {
    await recordSocialProviderUsage({
      organisationId,
      provider: "ZERNIO",
      capability,
      network,
      latencyMs,
      errorCode: res.ok ? undefined : `http_${res.status}`,
    }).catch(() => undefined);
  }
  return { ok: res.ok, status: res.status, json, latencyMs };
}

export async function getOrCreateZernioProfile(organisationId: string) {
  const existing = await prisma.zernioProfile.findUnique({ where: { organisationId } });
  if (existing) return existing;
  return prisma.zernioProfile.create({
    data: {
      organisationId,
      status: isZernioConfigured() ? "CONFIGURED" : "NOT_CONFIGURED",
      connectedAccounts: [],
    },
  });
}

export async function getZernioProfileView(organisationId: string) {
  const profile = await getOrCreateZernioProfile(organisationId);
  return {
    configured: isZernioConfigured(),
    status: profile.status,
    zernioProfileId: profile.zernioProfileId,
    connectedAccounts: Array.isArray(profile.connectedAccounts) ? profile.connectedAccounts : [],
    lastSyncAt: profile.lastSyncAt?.toISOString() ?? null,
    lastError: profile.lastError,
    /** Never include master API key */
  };
}

/**
 * Ensure remote Zernio profile exists for this org (1:1 mapping).
 * Uses organisationId as unique profile name within the Zernio team.
 */
export async function ensureRemoteZernioProfile(organisationId: string): Promise<{
  ok: boolean;
  zernioProfileId?: string;
  error?: string;
  code?: string;
}> {
  if (!isZernioConfigured()) {
    return { ok: false, code: "ZERNIO_NOT_CONFIGURED", error: "Zernio API key not configured" };
  }

  const local = await getOrCreateZernioProfile(organisationId);
  if (local.zernioProfileId) {
    return { ok: true, zernioProfileId: local.zernioProfileId };
  }

  const res = await zernioFetch("/profiles", {
    method: "POST",
    body: JSON.stringify({
      name: `agentdesk-${organisationId}`,
    }),
    organisationId,
    capability: "CONNECT_ACCOUNT",
  });

  const data = (res.json.data || res.json.profile || res.json) as Record<string, unknown>;
  const id =
    (typeof data._id === "string" && data._id) ||
    (typeof data.id === "string" && data.id) ||
    (typeof res.json._id === "string" && res.json._id) ||
    undefined;

  if (!res.ok || !id) {
    const message =
      (typeof res.json.message === "string" && res.json.message) ||
      (typeof res.json.error === "string" && res.json.error) ||
      `Zernio profile create failed (${res.status})`;
    await prisma.zernioProfile.update({
      where: { organisationId },
      data: { status: "DEGRADED", lastError: message },
    });
    return { ok: false, error: message };
  }

  await prisma.zernioProfile.update({
    where: { organisationId },
    data: {
      zernioProfileId: id,
      status: "CONFIGURED",
      lastError: null,
    },
  });

  return { ok: true, zernioProfileId: id };
}

export type ZernioConnectPlatform = "instagram" | "linkedin";

/**
 * Ask Zernio for an OAuth/connect URL for a platform.
 * headless=true prepares white-label / Agent Desk-owned UX later; hosted selection OK for LIVE_E2E.
 * Instagram uses direct Instagram Login (no Facebook Page requirement on the normal path).
 */
export async function createZernioConnectUrl(input: {
  organisationId: string;
  platform: ZernioConnectPlatform;
  redirectUrl: string;
  /** Prefer headless when Agent Desk owns the visual experience */
  headless?: boolean;
}): Promise<{ ok: boolean; url?: string; error?: string; code?: string; headless?: boolean }> {
  if (!isZernioConfigured()) {
    return { ok: false, code: "ZERNIO_NOT_CONFIGURED", error: "Zernio API key not configured" };
  }

  const ensured = await ensureRemoteZernioProfile(input.organisationId);
  if (!ensured.ok || !ensured.zernioProfileId) {
    return { ok: false, code: ensured.code, error: ensured.error || "Could not create Zernio profile" };
  }

  const headless = input.headless === true;
  const state = createZernioConnectState(input.organisationId);
  const redirectWithState = (() => {
    try {
      const u = new URL(input.redirectUrl);
      u.searchParams.set("state", state);
      return u.toString();
    } catch {
      const join = input.redirectUrl.includes("?") ? "&" : "?";
      return `${input.redirectUrl}${join}state=${encodeURIComponent(state)}`;
    }
  })();

  const params = new URLSearchParams({
    profileId: ensured.zernioProfileId,
    redirect_url: redirectWithState,
  });
  if (headless) params.set("headless", "true");

  // Instagram: default connect path is Instagram Login (not Facebook Page)
  const res = await zernioFetch(`/connect/${input.platform}?${params.toString()}`, {
    method: "GET",
    organisationId: input.organisationId,
    capability: "CONNECT_ACCOUNT",
    network: input.platform.toUpperCase(),
  });

  const data = (res.json.data || res.json) as Record<string, unknown>;
  const url =
    (typeof data.authUrl === "string" && data.authUrl) ||
    (typeof data.url === "string" && data.url) ||
    (typeof res.json.authUrl === "string" && (res.json.authUrl as string)) ||
    undefined;

  if (!res.ok || !url) {
    const message =
      (typeof res.json.message === "string" && res.json.message) ||
      `Zernio connect URL failed (${res.status})`;
    await prisma.zernioProfile.update({
      where: { organisationId: input.organisationId },
      data: { status: "DEGRADED", lastError: message },
    });
    return { ok: false, error: message };
  }

  await prisma.zernioProfile.update({
    where: { organisationId: input.organisationId },
    data: { status: "CONNECTING", lastError: null },
  });

  return { ok: true, url, headless };
}

export async function syncZernioConnectedAccounts(organisationId: string): Promise<{
  ok: boolean;
  accounts: ZernioConnectedAccount[];
  error?: string;
}> {
  if (!isZernioConfigured()) {
    return { ok: false, accounts: [], error: "Zernio not configured" };
  }
  const local = await getOrCreateZernioProfile(organisationId);
  if (!local.zernioProfileId) {
    return { ok: false, accounts: [], error: "Zernio profile not linked" };
  }

  const res = await zernioFetch(`/profiles/${local.zernioProfileId}/accounts`, {
    method: "GET",
    organisationId,
    capability: "CONNECT_ACCOUNT",
  });

  if (!res.ok) {
    // Fallback: some API shapes list accounts under profile get
    const profileRes = await zernioFetch(`/profiles/${local.zernioProfileId}`, {
      method: "GET",
      organisationId,
      capability: "CONNECT_ACCOUNT",
    });
    if (!profileRes.ok) {
      return { ok: false, accounts: [], error: `Account sync failed (${res.status})` };
    }
    const pdata = (profileRes.json.data || profileRes.json) as Record<string, unknown>;
    const raw = (pdata.accounts || pdata.socialAccounts || []) as unknown[];
    const accounts = normalizeAccounts(raw);
    await persistAccounts(organisationId, accounts);
    return { ok: true, accounts };
  }

  const data = (res.json.data || res.json) as Record<string, unknown>;
  const raw = (Array.isArray(data) ? data : data.accounts || data.items || []) as unknown[];
  const accounts = normalizeAccounts(raw);
  await persistAccounts(organisationId, accounts);
  return { ok: true, accounts };
}

function normalizeAccounts(raw: unknown[]): ZernioConnectedAccount[] {
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      const accountId = String(o._id || o.id || o.accountId || "");
      if (!accountId) return null;
      return {
        accountId,
        platform: String(o.platform || o.type || "unknown").toLowerCase(),
        displayName: typeof o.displayName === "string" ? o.displayName : undefined,
        username: typeof o.username === "string" ? o.username : undefined,
        authMode: typeof o.authMode === "string" ? o.authMode : undefined,
        status: typeof o.status === "string" ? o.status : "connected",
        connectedAt: typeof o.connectedAt === "string" ? o.connectedAt : undefined,
      } satisfies ZernioConnectedAccount;
    })
    .filter(Boolean) as ZernioConnectedAccount[];
}

async function persistAccounts(organisationId: string, accounts: ZernioConnectedAccount[]) {
  const hasIg = accounts.some((a) => a.platform.includes("instagram"));
  const hasLi = accounts.some((a) => a.platform.includes("linkedin"));
  await prisma.zernioProfile.update({
    where: { organisationId },
    data: {
      connectedAccounts: accounts,
      status: accounts.length ? "CONNECTED" : "CONFIGURED",
      lastSyncAt: new Date(),
      lastError: null,
      metadata: {
        instagramConnected: hasIg,
        linkedinConnected: hasLi,
        instagramStatus: hasIg ? "CONNECTED" : "DISCONNECTED",
        linkedinStatus: hasLi ? "CONNECTED" : "DISCONNECTED",
        requiresFacebookPage: false,
        instagramRequiresProfessionalAccount: true,
      },
    },
  });
  await ensureZernioMessagingBindings(organisationId, accounts);
}

/**
 * Upsert Integration + MessagingChannel rows for Instagram accounts so inbox
 * ingestion and outbound routing stay tenant-scoped.
 */
export async function ensureZernioMessagingBindings(
  organisationId: string,
  accounts: ZernioConnectedAccount[],
) {
  const { IntegrationType } = await import("@prisma/client");
  const { MESSAGING_PROVIDER } = await import("@/services/messaging/providers");

  await prisma.integration.upsert({
    where: {
      organisationId_type_name: {
        organisationId,
        type: IntegrationType.ZERNIO,
        name: "default",
      },
    },
    create: {
      organisationId,
      type: IntegrationType.ZERNIO,
      name: "default",
      isActive: accounts.length > 0,
      config: { provider: "ZERNIO" },
    },
    update: { isActive: accounts.length > 0 },
  });

  for (const account of accounts) {
    if (!account.platform.includes("instagram")) continue;
    await prisma.messagingChannel.upsert({
      where: {
        organisationId_provider_externalId: {
          organisationId,
          provider: MESSAGING_PROVIDER.ZERNIO,
          externalId: account.accountId,
        },
      },
      create: {
        organisationId,
        provider: MESSAGING_PROVIDER.ZERNIO,
        externalId: account.accountId,
        displayName: account.displayName || account.username || "Instagram (Zernio)",
        instagramUsername: account.username || null,
        isActive: true,
      },
      update: {
        displayName: account.displayName || account.username || undefined,
        instagramUsername: account.username || undefined,
        isActive: true,
      },
    });
  }
}

export async function publishViaZernio(input: {
  organisationId: string;
  content: string;
  accountIds: string[];
  mediaUrls?: string[];
  scheduledAt?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  assertZernioConfigured();
  const local = await getOrCreateZernioProfile(input.organisationId);
  if (!local.zernioProfileId) return { ok: false, error: "Zernio profile not linked" };

  const res = await zernioFetch("/posts", {
    method: "POST",
    body: JSON.stringify({
      profileId: local.zernioProfileId,
      content: input.content,
      accountIds: input.accountIds,
      mediaUrls: input.mediaUrls,
      scheduledAt: input.scheduledAt,
    }),
    organisationId: input.organisationId,
    capability: input.scheduledAt ? "SCHEDULE" : "PUBLISH",
  });

  if (!res.ok) {
    return {
      ok: false,
      error:
        (typeof res.json.message === "string" && res.json.message) ||
        `Publish failed (${res.status})`,
    };
  }
  const data = (res.json.data || res.json) as Record<string, unknown>;
  const id = String(data._id || data.id || "");
  return { ok: true, id: id || undefined };
}

export async function storeZernioMetrics(input: {
  organisationId: string;
  platform: string;
  externalPostId: string;
  metrics: Record<string, number | null | undefined>;
}) {
  const retrievedAt = new Date();
  for (const [metric, value] of Object.entries(input.metrics)) {
    await prisma.socialMetricFact.create({
      data: {
        organisationId: input.organisationId,
        platform: input.platform,
        externalPostId: input.externalPostId,
        metric,
        value: value === undefined ? null : value,
        source: "zernio",
        retrievedAt,
      },
    });
  }
}

/**
 * Verify X-Zernio-Signature = lowercase hex HMAC-SHA256(rawBody, webhookSecret)
 */
export function verifyZernioWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = getEnv().ZERNIO_WEBHOOK_SECRET?.trim();
  if (!secret || !signatureHeader) return false;
  const computed = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(computed);
  const b = Buffer.from(signatureHeader.trim().toLowerCase());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function findOrganisationIdByZernioProfileId(
  zernioProfileId: string,
): Promise<string | null> {
  const row = await prisma.zernioProfile.findFirst({
    where: { zernioProfileId },
    select: { organisationId: true },
  });
  return row?.organisationId ?? null;
}

export async function findOrganisationIdByZernioAccountId(
  accountId: string,
): Promise<{ organisationId: string; profileId: string } | null> {
  const profiles = await prisma.zernioProfile.findMany({
    where: { status: { in: ["CONNECTED", "CONNECTING", "CONFIGURED", "DEGRADED"] } },
    select: { id: true, organisationId: true, connectedAccounts: true },
    take: 500,
  });
  for (const p of profiles) {
    const accounts = Array.isArray(p.connectedAccounts)
      ? (p.connectedAccounts as ZernioConnectedAccount[])
      : [];
    if (accounts.some((a) => a.accountId === accountId)) {
      return { organisationId: p.organisationId, profileId: p.id };
    }
  }
  return null;
}

export function zernioInstagramMessagingCapability(connected: boolean): {
  directMessages: boolean;
  coldDm: boolean;
  note: string;
} {
  return {
    directMessages: connected,
    coldDm: false,
    note: connected
      ? "Permitted IG replies only via existing conversation + dispatchOutboundMessage"
      : "Connect Instagram Professional (Business/Creator) via Instagram Login — no Facebook Page required",
  };
}

export function zernioLinkedInMessagingCapability(): {
  directMessages: false;
  note: string;
} {
  return {
    directMessages: false,
    note: "LinkedIn DMs are not implemented through Zernio — use Open LinkedIn + Copy Connection Note",
  };
}

export function preferredProviderForCapability(input: {
  network: SocialPlatformNetwork;
  capability: "CONNECT_ACCOUNT" | "PUBLISH" | "SCHEDULE" | "ANALYTICS" | "DIRECT_MESSAGES";
}): "ZERNIO" | "AYRSHARE" | "META_INSTAGRAM" | "MANYCHAT" | "LINKEDIN_NATIVE" | "MANUAL" {
  if (input.network === "LINKEDIN" && input.capability === "DIRECT_MESSAGES") {
    return "MANUAL";
  }
  if (isZernioConfigured()) {
    if (
      input.capability === "CONNECT_ACCOUNT" ||
      input.capability === "PUBLISH" ||
      input.capability === "SCHEDULE" ||
      input.capability === "ANALYTICS"
    ) {
      return "ZERNIO";
    }
    if (input.network === "INSTAGRAM" && input.capability === "DIRECT_MESSAGES") {
      return "ZERNIO";
    }
  }
  if (input.network === "INSTAGRAM" && input.capability === "DIRECT_MESSAGES") {
    return "META_INSTAGRAM";
  }
  if (process.env.AYRSHARE_API_KEY?.trim() && input.capability !== "DIRECT_MESSAGES") {
    return "AYRSHARE";
  }
  return "MANUAL";
}
