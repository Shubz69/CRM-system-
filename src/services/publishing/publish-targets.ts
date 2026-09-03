/**
 * Canonical publish-target resolution.
 *
 * Source of truth for connected social accounts is ZernioProfile.connectedAccounts
 * (customer Social Accounts UX). Content OS / PublishingJob still use SocialConnection
 * ids for approval + dispatch compatibility — this module syncs and resolves them.
 *
 * Customers see Instagram @handle / LinkedIn / YouTube labels — never provider internals.
 */

import {
  SocialConnectionStatus,
  SocialPlatform,
  type SocialConnection,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  getOrCreateZernioProfile,
  type ZernioConnectedAccount,
} from "@/adapters/zernio";

export const ZERNIO_PROVIDER_META_KEY = "provider";
export const ZERNIO_PROVIDER_VALUE = "ZERNIO";

export type PublishTarget = {
  id: string;
  platform: "INSTAGRAM" | "LINKEDIN" | "YOUTUBE" | "TIKTOK";
  /** Customer-facing label, e.g. "@acme" or "Acme Ltd" */
  label: string;
  status: SocialConnectionStatus;
  externalAccountId: string;
  provider: "ZERNIO" | "NATIVE";
  eligible: boolean;
};

type ConnectionMetadata = {
  provider?: string;
  zernioNetwork?: string;
  zernioAccountId?: string;
  username?: string;
  displayName?: string;
};

function asMeta(raw: unknown): ConnectionMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as ConnectionMetadata;
}

function isActiveZernioAccount(account: ZernioConnectedAccount): boolean {
  const status = String(account.status || "connected").toLowerCase();
  if (status.includes("disconnect") || status === "revoked" || status === "inactive") {
    return false;
  }
  if (status.includes("reauth") || status.includes("expired")) return false;
  return Boolean(account.accountId);
}

function mapZernioPlatform(
  platformRaw: string,
): "INSTAGRAM" | "LINKEDIN" | "YOUTUBE" | null {
  const p = platformRaw.toLowerCase();
  if (p.includes("instagram")) return "INSTAGRAM";
  if (p.includes("linkedin")) return "LINKEDIN";
  if (p.includes("youtube")) return "YOUTUBE";
  return null;
}

function toSocialPlatformEnum(
  network: "INSTAGRAM" | "LINKEDIN" | "YOUTUBE",
): SocialPlatform | null {
  if (network === "INSTAGRAM") return SocialPlatform.INSTAGRAM;
  if (network === "LINKEDIN") return SocialPlatform.LINKEDIN;
  // YouTube is not on SocialPlatform enum yet — store under LINKEDIN row key is wrong.
  // We persist YouTube as INSTAGRAM? No. Use metadata-only SocialConnection with
  // platform LINKEDIN would collide. Prefer storing YOUTUBE targets via metadata
  // on a dedicated externalAccountId namespace without enum expansion:
  // Use TIKTOK slot only if unused — still wrong.
  // Practical: map YOUTUBE → SocialPlatform.TIKTOK with metadata.zernioNetwork=youtube
  // is unacceptable for customer platform filter.
  //
  // Resolution: keep YouTube targets in-memory from Zernio and create SocialConnection
  // rows using INSTAGRAM/LINKEDIN only for those networks; for YouTube use TIKTOK
  // as storage enum with metadata.zernioNetwork === "youtube" and filter by metadata
  // when listing. Content platform string remains "youtube".
  if (network === "YOUTUBE") return SocialPlatform.TIKTOK;
  return null;
}

function customerLabel(account: ZernioConnectedAccount, network: string): string {
  const username = account.username?.replace(/^@/, "").trim();
  const name = account.displayName?.trim();
  if (network === "YOUTUBE") {
    const channel = name || (username ? `@${username}` : null);
    return channel ? `YouTube · ${channel}` : "YouTube channel";
  }
  if (network === "INSTAGRAM") {
    return username ? `Instagram · @${username}` : name ? `Instagram · ${name}` : "Instagram account";
  }
  if (network === "LINKEDIN") {
    return name || username ? `LinkedIn · ${name || username}` : "LinkedIn account";
  }
  if (network === "TIKTOK") {
    return username ? `TikTok · @${username}` : name ? `TikTok · ${name}` : "TikTok account";
  }
  return name || username || "Social account";
}

/**
 * Upsert SocialConnection rows from org-scoped Zernio connected accounts.
 * Does not create competing OAuth — mirrors already-connected state only.
 */
export async function syncPublishTargetsFromConnectedAccounts(
  organisationId: string,
): Promise<SocialConnection[]> {
  const profile = await getOrCreateZernioProfile(organisationId);
  const accounts = Array.isArray(profile.connectedAccounts)
    ? (profile.connectedAccounts as ZernioConnectedAccount[])
    : [];

  const active = accounts.filter(isActiveZernioAccount);
  const syncedIds: string[] = [];

  for (const account of active) {
    const network = mapZernioPlatform(account.platform);
    if (!network) continue;
    const platformEnum = toSocialPlatformEnum(network);
    if (!platformEnum) continue;

    // Namespace external id so native OAuth and Zernio never collide.
    const externalAccountId = `zernio:${account.accountId}`;
    const label = customerLabel(account, network);
    const metadata = {
      provider: ZERNIO_PROVIDER_VALUE,
      zernioNetwork: network.toLowerCase(),
      zernioAccountId: account.accountId,
      username: account.username || null,
      displayName: account.displayName || null,
    };

    const row = await prisma.socialConnection.upsert({
      where: {
        organisationId_platform_externalAccountId: {
          organisationId,
          platform: platformEnum,
          externalAccountId,
        },
      },
      create: {
        organisationId,
        platform: platformEnum,
        externalAccountId,
        displayName: label,
        status: SocialConnectionStatus.ACTIVE,
        scopes: ["zernio:publish"],
        capabilities: { listen: true, publish: true, message: network === "INSTAGRAM" },
        lastSyncedAt: new Date(),
        metadata,
      },
      update: {
        displayName: label,
        status: SocialConnectionStatus.ACTIVE,
        capabilities: { listen: true, publish: true, message: network === "INSTAGRAM" },
        lastSyncedAt: new Date(),
        metadata,
      },
    });
    syncedIds.push(row.id);
  }

  // Mark previously synced Zernio rows inactive when no longer connected (preserve rows).
  const existingZernio = await prisma.socialConnection.findMany({
    where: {
      organisationId,
      externalAccountId: { startsWith: "zernio:" },
    },
  });
  for (const row of existingZernio) {
    if (syncedIds.includes(row.id)) continue;
    if (row.status === SocialConnectionStatus.ACTIVE) {
      await prisma.socialConnection.update({
        where: { id: row.id },
        data: { status: SocialConnectionStatus.REVOKED },
      });
    }
  }

  return prisma.socialConnection.findMany({
    where: {
      organisationId,
      status: SocialConnectionStatus.ACTIVE,
    },
    orderBy: { platform: "asc" },
  });
}

function publishPlatformForConnection(conn: SocialConnection): PublishTarget["platform"] {
  const meta = asMeta(conn.metadata);
  if (meta.zernioNetwork === "youtube" || meta.zernioNetwork === "YOUTUBE") {
    return "YOUTUBE";
  }
  if (conn.platform === SocialPlatform.INSTAGRAM) return "INSTAGRAM";
  if (conn.platform === SocialPlatform.LINKEDIN) return "LINKEDIN";
  if (conn.platform === SocialPlatform.TIKTOK) {
    return meta.provider === ZERNIO_PROVIDER_VALUE ? "YOUTUBE" : "TIKTOK";
  }
  return "INSTAGRAM";
}

/** Customer-facing publish targets (eligible connected accounts only). */
export async function listPublishTargets(organisationId: string): Promise<PublishTarget[]> {
  await syncPublishTargetsFromConnectedAccounts(organisationId);
  const rows = await prisma.socialConnection.findMany({
    where: {
      organisationId,
      status: SocialConnectionStatus.ACTIVE,
    },
    orderBy: [{ platform: "asc" }, { displayName: "asc" }],
  });

  return rows
    .map((conn) => {
      const meta = asMeta(conn.metadata);
      const provider: PublishTarget["provider"] =
        meta.provider === ZERNIO_PROVIDER_VALUE ||
        conn.externalAccountId.startsWith("zernio:")
          ? "ZERNIO"
          : "NATIVE";
      const platform = publishPlatformForConnection(conn);
      let label =
        conn.displayName?.trim() ||
        (platform === "INSTAGRAM"
          ? "Instagram account"
          : platform === "LINKEDIN"
            ? "LinkedIn account"
            : platform === "YOUTUBE"
              ? "YouTube channel"
              : platform === "TIKTOK"
                ? "TikTok account"
                : "Social account");
      // Canonical customer labels — never expose provider / connection ids.
      if (platform === "YOUTUBE" && label && !/^YouTube\s*·/.test(label)) {
        label = `YouTube · ${label.replace(/^@/, "")}`;
      }
      if (platform === "TIKTOK" && label && !/^TikTok\s*·/.test(label)) {
        const handle = label.replace(/^@/, "");
        label = `TikTok · @${handle}`;
      }
      if (platform === "INSTAGRAM" && label && !/^Instagram\s*·/.test(label)) {
        const handle = label.replace(/^@/, "");
        label = handle ? `Instagram · @${handle}` : "Instagram account";
      }
      return {
        id: conn.id,
        platform,
        label,
        status: conn.status,
        externalAccountId: conn.externalAccountId,
        provider,
        eligible: conn.status === SocialConnectionStatus.ACTIVE,
      };
    })
    .filter((t) => t.eligible);
}

export function isZernioBackedConnection(conn: {
  externalAccountId: string;
  metadata?: unknown;
}): boolean {
  const meta = asMeta(conn.metadata);
  return (
    meta.provider === ZERNIO_PROVIDER_VALUE ||
    conn.externalAccountId.startsWith("zernio:")
  );
}

export function zernioAccountIdFromConnection(conn: {
  externalAccountId: string;
  metadata?: unknown;
}): string | null {
  const meta = asMeta(conn.metadata);
  if (typeof meta.zernioAccountId === "string" && meta.zernioAccountId) {
    return meta.zernioAccountId;
  }
  if (conn.externalAccountId.startsWith("zernio:")) {
    return conn.externalAccountId.slice("zernio:".length) || null;
  }
  return null;
}

/** Resolve org-scoped connection for publish; rejects cross-org / inactive. */
export async function resolvePublishTargetConnection(input: {
  organisationId: string;
  socialConnectionId: string;
}): Promise<SocialConnection | null> {
  return prisma.socialConnection.findFirst({
    where: {
      id: input.socialConnectionId,
      organisationId: input.organisationId,
      status: SocialConnectionStatus.ACTIVE,
    },
  });
}
