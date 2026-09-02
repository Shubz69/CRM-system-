/**
 * Ayrshare adapter — server-only primary API key.
 * Never send primary API key to the browser.
 * Prefer Profile/JWT linking for customer social connections.
 */

import { getEnv } from "@/lib/env";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { recordSocialProviderUsage } from "@/services/social-prospecting/usage";

const AYRSHARE_API_BASE = "https://api.ayrshare.com/api";

export function isAyrshareConfigured(): boolean {
  return Boolean(getEnv().AYRSHARE_API_KEY?.trim());
}

export function assertAyrshareConfigured(): void {
  if (!isAyrshareConfigured()) {
    throw Object.assign(new Error("Ayrshare is not configured"), {
      code: "AYRSHARE_NOT_CONFIGURED",
    });
  }
}

export async function getOrCreateAyrshareProfile(organisationId: string) {
  const existing = await prisma.ayrshareProfile.findUnique({ where: { organisationId } });
  if (existing) return existing;
  return prisma.ayrshareProfile.create({
    data: {
      organisationId,
      status: isAyrshareConfigured() ? "CONFIGURED" : "NOT_CONFIGURED",
      connectedNetworks: [],
    },
  });
}

export async function getAyrshareProfileView(organisationId: string) {
  const profile = await getOrCreateAyrshareProfile(organisationId);
  return {
    configured: isAyrshareConfigured(),
    status: profile.status,
    ayrshareProfileId: profile.ayrshareProfileId,
    connectedNetworks: profile.connectedNetworks,
    lastSyncAt: profile.lastSyncAt?.toISOString() ?? null,
    lastError: profile.lastError,
    /** Never include encryptedProfileKey or primary API key */
  };
}

/**
 * Generate a social linking JWT / URL for the organisation's Ayrshare user profile.
 * Does not call paid APIs in unit tests — returns a structured placeholder when key missing.
 */
export async function createAyrshareSocialLink(input: {
  organisationId: string;
  /** Optional networks to request */
  networks?: string[];
}): Promise<{ ok: boolean; url?: string; error?: string; code?: string }> {
  if (!isAyrshareConfigured()) {
    return { ok: false, code: "AYRSHARE_NOT_CONFIGURED", error: "Ayrshare API key not configured" };
  }

  const profile = await getOrCreateAyrshareProfile(input.organisationId);
  const started = Date.now();

  try {
    const env = getEnv();
    const res = await fetch(`${AYRSHARE_API_BASE}/profiles/generateJWT`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.AYRSHARE_API_KEY}`,
      },
      body: JSON.stringify({
        domain: env.AYRSHARE_DOMAIN || undefined,
        privateKey: env.AYRSHARE_PRIVATE_KEY || undefined,
        profileKey: profile.ayrshareProfileId || undefined,
        // networks optional — Ayrshare docs vary; pass through when provided
        ...(input.networks?.length ? { allowedSocial: input.networks } : {}),
      }),
    });

    const json = (await res.json().catch(() => ({}))) as {
      url?: string;
      token?: string;
      profileKey?: string;
      message?: string;
    };

    await recordSocialProviderUsage({
      organisationId: input.organisationId,
      provider: "AYRSHARE",
      capability: "CONNECT_ACCOUNT",
      latencyMs: Date.now() - started,
      errorCode: res.ok ? undefined : `http_${res.status}`,
    });

    if (!res.ok) {
      await prisma.ayrshareProfile.update({
        where: { organisationId: input.organisationId },
        data: {
          status: "DEGRADED",
          lastError: json.message || `Ayrshare JWT failed (${res.status})`,
        },
      });
      return { ok: false, error: json.message || `Ayrshare error (${res.status})` };
    }

    if (json.profileKey) {
      await prisma.ayrshareProfile.update({
        where: { organisationId: input.organisationId },
        data: {
          ayrshareProfileId: json.profileKey,
          encryptedProfileKey: encryptSecret(json.profileKey),
          status: "CONNECTING",
          lastError: null,
        },
      });
    }

    return { ok: true, url: json.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ayrshare link failed";
    await recordSocialProviderUsage({
      organisationId: input.organisationId,
      provider: "AYRSHARE",
      capability: "CONNECT_ACCOUNT",
      latencyMs: Date.now() - started,
      errorCode: "network",
    });
    return { ok: false, error: message };
  }
}

export async function publishViaAyrshare(input: {
  organisationId: string;
  post: string;
  platforms: string[];
  mediaUrls?: string[];
  scheduleDate?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  assertAyrshareConfigured();
  const profile = await getOrCreateAyrshareProfile(input.organisationId);
  if (!profile.ayrshareProfileId && !profile.encryptedProfileKey) {
    return { ok: false, error: "Ayrshare profile not linked for this organisation" };
  }

  const profileKey = profile.ayrshareProfileId
    || (profile.encryptedProfileKey ? decryptSecret(profile.encryptedProfileKey) : null);
  if (!profileKey) return { ok: false, error: "Ayrshare profile key missing" };

  const started = Date.now();
  const env = getEnv();
  const res = await fetch(`${AYRSHARE_API_BASE}/post`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.AYRSHARE_API_KEY}`,
      "Profile-Key": profileKey,
    },
    body: JSON.stringify({
      post: input.post,
      platforms: input.platforms,
      mediaUrls: input.mediaUrls,
      scheduleDate: input.scheduleDate,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };

  await recordSocialProviderUsage({
    organisationId: input.organisationId,
    provider: "AYRSHARE",
    capability: input.scheduleDate ? "SCHEDULE" : "PUBLISH",
    network: input.platforms.join(","),
    latencyMs: Date.now() - started,
    errorCode: res.ok ? undefined : `http_${res.status}`,
  });

  if (!res.ok) return { ok: false, error: json.message || `Publish failed (${res.status})` };
  return { ok: true, id: json.id };
}

/**
 * Normalize Ayrshare analytics into SocialMetricFact — missing metrics stay NULL.
 */
export async function storeAyrshareMetrics(input: {
  organisationId: string;
  platform: string;
  externalPostId: string;
  metrics: Record<string, number | null | undefined>;
  source?: string;
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
        source: input.source || "ayrshare",
        retrievedAt,
      },
    });
  }
}
