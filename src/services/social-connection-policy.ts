/**
 * Org-scoped social connection policy (beta cost control).
 * Stored in OrganisationPreference — no schema migration required.
 *
 * Defaults:
 * - Existing orgs without a preference: enabled, unlimited (null max) — preserves production.
 * - New tester/workspaces: enabled, max 2, all networks allowed (set at create time).
 */

import { prisma } from "@/lib/db";

export const SOCIAL_CONNECTION_POLICY_KEY = "social_connection_policy";

export const SOCIAL_POLICY_NETWORKS = ["INSTAGRAM", "LINKEDIN", "YOUTUBE"] as const;
export type SocialPolicyNetwork = (typeof SOCIAL_POLICY_NETWORKS)[number];

export type SocialConnectionPolicy = {
  socialConnectionsEnabled: boolean;
  /** null = unlimited (production-safe default for orgs without an explicit preference) */
  maxConnectedSocialAccounts: number | null;
  allowedNetworks: SocialPolicyNetwork[];
};

/** Existing production orgs: do not clamp until platform admin sets a limit. */
export const LEGACY_UNLIMITED_POLICY: SocialConnectionPolicy = {
  socialConnectionsEnabled: true,
  maxConnectedSocialAccounts: null,
  allowedNetworks: [...SOCIAL_POLICY_NETWORKS],
};

/** Safer default for newly created tester / customer workspaces. */
export const NEW_ORG_BETA_POLICY: SocialConnectionPolicy = {
  socialConnectionsEnabled: true,
  maxConnectedSocialAccounts: 2,
  allowedNetworks: [...SOCIAL_POLICY_NETWORKS],
};

function asNetwork(value: unknown): SocialPolicyNetwork | null {
  const v = String(value || "").toUpperCase();
  return (SOCIAL_POLICY_NETWORKS as readonly string[]).includes(v)
    ? (v as SocialPolicyNetwork)
    : null;
}

export function normalizeSocialConnectionPolicy(raw: unknown): SocialConnectionPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...LEGACY_UNLIMITED_POLICY };
  }
  const o = raw as Record<string, unknown>;
  const networks = Array.isArray(o.allowedNetworks)
    ? o.allowedNetworks.map(asNetwork).filter(Boolean)
    : [...SOCIAL_POLICY_NETWORKS];
  const max =
    o.maxConnectedSocialAccounts === null || o.maxConnectedSocialAccounts === undefined
      ? null
      : Number(o.maxConnectedSocialAccounts);
  return {
    socialConnectionsEnabled: o.socialConnectionsEnabled !== false,
    maxConnectedSocialAccounts:
      max === null || !Number.isFinite(max) || max < 0 ? null : Math.floor(max),
    allowedNetworks: (networks.length ? networks : [...SOCIAL_POLICY_NETWORKS]) as SocialPolicyNetwork[],
  };
}

export async function getSocialConnectionPolicy(
  organisationId: string,
): Promise<SocialConnectionPolicy> {
  const row = await prisma.organisationPreference.findUnique({
    where: {
      organisationId_key: { organisationId, key: SOCIAL_CONNECTION_POLICY_KEY },
    },
  });
  if (!row) return { ...LEGACY_UNLIMITED_POLICY };
  return normalizeSocialConnectionPolicy(row.value);
}

export async function setSocialConnectionPolicy(input: {
  organisationId: string;
  policy: SocialConnectionPolicy;
  updatedByUserId?: string | null;
}): Promise<SocialConnectionPolicy> {
  const policy = normalizeSocialConnectionPolicy(input.policy);
  await prisma.organisationPreference.upsert({
    where: {
      organisationId_key: {
        organisationId: input.organisationId,
        key: SOCIAL_CONNECTION_POLICY_KEY,
      },
    },
    create: {
      organisationId: input.organisationId,
      key: SOCIAL_CONNECTION_POLICY_KEY,
      value: policy,
      updatedByUserId: input.updatedByUserId ?? null,
    },
    update: {
      value: policy,
      updatedByUserId: input.updatedByUserId ?? null,
    },
  });
  return policy;
}

export async function ensureNewOrgSocialConnectionPolicy(organisationId: string) {
  const existing = await prisma.organisationPreference.findUnique({
    where: {
      organisationId_key: { organisationId, key: SOCIAL_CONNECTION_POLICY_KEY },
    },
  });
  if (existing) return normalizeSocialConnectionPolicy(existing.value);
  return setSocialConnectionPolicy({
    organisationId,
    policy: NEW_ORG_BETA_POLICY,
  });
}

export type SocialConnectGateResult =
  | { ok: true; policy: SocialConnectionPolicy; connectedCount: number }
  | {
      ok: false;
      code: "SOCIAL_CONNECTIONS_DISABLED" | "SOCIAL_NETWORK_NOT_ALLOWED" | "SOCIAL_CONNECTION_QUOTA";
      error: string;
      policy: SocialConnectionPolicy;
      connectedCount: number;
    };

export function countActiveConnectedAccounts(
  connectedAccounts: Array<{ platform?: string; status?: string }>,
): number {
  return connectedAccounts.filter((a) => {
    const status = String(a.status || "connected").toLowerCase();
    if (status.includes("disconnect") || status === "revoked" || status === "inactive") {
      return false;
    }
    return Boolean(a.platform);
  }).length;
}

export function networkAlreadyConnected(
  connectedAccounts: Array<{ platform?: string; status?: string }>,
  network: SocialPolicyNetwork,
): boolean {
  const needle = network.toLowerCase();
  return connectedAccounts.some((a) => {
    const status = String(a.status || "connected").toLowerCase();
    if (status.includes("disconnect") || status === "revoked" || status === "inactive") {
      return false;
    }
    return String(a.platform || "").toLowerCase().includes(needle);
  });
}

/**
 * Gate before starting a NEW OAuth connect for a network.
 * Reconnect of an already-connected network is allowed (does not consume extra quota).
 */
export async function assertCanStartSocialConnect(input: {
  organisationId: string;
  network: SocialPolicyNetwork;
  connectedAccounts: Array<{ platform?: string; status?: string }>;
}): Promise<SocialConnectGateResult> {
  const policy = await getSocialConnectionPolicy(input.organisationId);
  const connectedCount = countActiveConnectedAccounts(input.connectedAccounts);

  if (!policy.socialConnectionsEnabled) {
    return {
      ok: false,
      code: "SOCIAL_CONNECTIONS_DISABLED",
      error: "Social account linking is not available for this workspace.",
      policy,
      connectedCount,
    };
  }

  if (!policy.allowedNetworks.includes(input.network)) {
    return {
      ok: false,
      code: "SOCIAL_NETWORK_NOT_ALLOWED",
      error: "This network is not enabled for your workspace.",
      policy,
      connectedCount,
    };
  }

  // Reconnect / re-auth of existing network does not consume an extra slot
  if (networkAlreadyConnected(input.connectedAccounts, input.network)) {
    return { ok: true, policy, connectedCount };
  }

  if (
    policy.maxConnectedSocialAccounts !== null &&
    connectedCount >= policy.maxConnectedSocialAccounts
  ) {
    return {
      ok: false,
      code: "SOCIAL_CONNECTION_QUOTA",
      error: "Your workspace has reached its connected-account limit.",
      policy,
      connectedCount,
    };
  }

  return { ok: true, policy, connectedCount };
}
