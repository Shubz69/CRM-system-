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

export function assertZernioConfigured(): void {
  if (!isZernioConfigured()) {
    throw Object.assign(new Error("Zernio is not configured"), { code: "ZERNIO_NOT_CONFIGURED" });
  }
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
  const params = new URLSearchParams({
    profileId: ensured.zernioProfileId,
    redirect_url: input.redirectUrl,
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
        requiresFacebookPage: false,
        instagramRequiresProfessionalAccount: true,
      },
    },
  });
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
