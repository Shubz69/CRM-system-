/**
 * Evaluate per-org connector capabilities from real connection/env state.
 * Never invent “available” from LLM guesses.
 */

import {
  ConnectorCapabilityStatus,
  ConnectorConnectionStatus,
  SocialConnectionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { listConnectorDefinitions } from "@/services/connectors/catalogue";
import type {
  ConnectorCapability,
  CustomerHealthLabel,
} from "@/services/connectors/types";

function envConfigured(keys: string[]): boolean {
  return keys.some((k) => Boolean(process.env[k]?.trim()));
}

export async function evaluateOrganisationConnectors(organisationId: string) {
  const defs = listConnectorDefinitions();
  const social = await prisma.socialConnection.findMany({
    where: { organisationId },
  });
  const manychat = await prisma.integration.findFirst({
    where: { organisationId, type: "MANYCHAT" },
    include: { credentials: { select: { keyName: true, healthStatus: true } } },
  });

  const rows: Array<{
    providerKey: string;
    displayName: string;
    connectionStatus: ConnectorConnectionStatus;
    customerLabel: CustomerHealthLabel;
    connectionRef: string;
    capabilities: Array<{
      capability: string;
      status: ConnectorCapabilityStatus;
      provenance: string;
      missingScopes: string[];
      detail?: string;
    }>;
  }> = [];

  for (const def of defs) {
    if (def.providerKey === "instagram" || def.providerKey === "linkedin" || def.providerKey === "tiktok") {
      const platform = def.providerKey.toUpperCase() as "INSTAGRAM" | "LINKEDIN" | "TIKTOK";
      const conn = social.find((s) => s.platform === platform);
      const connectionRef = conn?.id ?? "none";
      const connectionStatus = mapSocialStatus(conn?.status, conn?.expiresAt ?? null);
      const caps = def.capabilities.map((capability) =>
        evaluateSocialCapability({
          capability,
          connectionStatus,
          scopes: conn?.scopes ?? [],
          required: def.requiredScopes,
          providerKey: def.providerKey,
        }),
      );
      // Public listen for IG/LI/TT is Apify — separate from OAuth.
      if (def.capabilities.includes("READ_PUBLIC_CONTENT")) {
        const listen = caps.find((c) => c.capability === "READ_PUBLIC_CONTENT");
        if (listen) {
          if (envConfigured(["APIFY_TOKEN"])) {
            listen.status = ConnectorCapabilityStatus.AVAILABLE;
            listen.provenance = "env:APIFY_TOKEN (licensed listen — not OAuth)";
          } else {
            listen.status = ConnectorCapabilityStatus.AUTH_REQUIRED;
            listen.provenance = "requires APIFY_TOKEN for public listen";
          }
        }
      }
      rows.push({
        providerKey: def.providerKey,
        displayName: def.displayName,
        connectionStatus,
        customerLabel: toCustomerLabel(connectionStatus, caps),
        connectionRef,
        capabilities: caps,
      });
      continue;
    }

    if (def.providerKey === "manychat") {
      const tokenOk = envConfigured(["MANYCHAT_API_TOKEN"]);
      const secretOk = Boolean(
        manychat?.credentials.some((c) => c.keyName === "webhook_secret"),
      );
      const connectionRef = manychat?.id ?? "env";
      const connectionStatus =
        tokenOk && secretOk
          ? ConnectorConnectionStatus.CONNECTED
          : tokenOk || secretOk
            ? ConnectorConnectionStatus.DEGRADED
            : ConnectorConnectionStatus.DISCONNECTED;
      const caps = def.capabilities.map((capability) => {
        if (capability === "SEND_MESSAGE") {
          return {
            capability,
            status: tokenOk
              ? ConnectorCapabilityStatus.CONNECTED
              : ConnectorCapabilityStatus.AUTH_REQUIRED,
            provenance: tokenOk ? "env:MANYCHAT_API_TOKEN" : "missing MANYCHAT_API_TOKEN",
            missingScopes: [] as string[],
          };
        }
        if (capability === "WEBHOOK_RECEIVE" || capability === "READ_MESSAGES") {
          return {
            capability,
            status: secretOk
              ? ConnectorCapabilityStatus.CONNECTED
              : ConnectorCapabilityStatus.AUTH_REQUIRED,
            provenance: secretOk
              ? "org IntegrationCredential webhook_secret"
              : "org webhook secret not configured",
            missingScopes: [] as string[],
          };
        }
        return {
          capability,
          status: ConnectorCapabilityStatus.UNSUPPORTED,
          provenance: "not mapped",
          missingScopes: [] as string[],
        };
      });
      rows.push({
        providerKey: def.providerKey,
        displayName: def.displayName,
        connectionStatus,
        customerLabel: toCustomerLabel(connectionStatus, caps),
        connectionRef,
        capabilities: caps,
      });
      continue;
    }

    // Env / research providers
    const envMap: Record<string, string[]> = {
      youtube: ["YOUTUBE_API_KEY"],
      tavily: ["TAVILY_API_KEY", "EXA_API_KEY"],
      apify: ["APIFY_TOKEN"],
      booking: ["BOOKING_WEBHOOK_SECRET", "DEFAULT_BOOKING_URL"],
      email_smtp: ["EMAIL_SMTP_URL"],
    };
    const keys = envMap[def.providerKey] ?? [];
    const ok = envConfigured(keys);
    const connectionStatus = ok
      ? ConnectorConnectionStatus.CONNECTED
      : ConnectorConnectionStatus.DISCONNECTED;
    const caps = def.capabilities.map((capability) => ({
      capability,
      status: ok
        ? ConnectorCapabilityStatus.AVAILABLE
        : capability === "DELETE_RECORD"
          ? ConnectorCapabilityStatus.DISABLED
          : ConnectorCapabilityStatus.AUTH_REQUIRED,
      provenance: ok ? `env:${keys.join("|")}` : `missing ${keys.join("|")}`,
      missingScopes: [] as string[],
      detail: def.commercialRestrictions?.join("; "),
    }));
    rows.push({
      providerKey: def.providerKey,
      displayName: def.displayName,
      connectionStatus,
      customerLabel: toCustomerLabel(connectionStatus, caps),
      connectionRef: "env",
      capabilities: caps,
    });
  }

  // Persist capability states in parallel (idempotent upsert).
  await Promise.all(
    rows.flatMap((row) =>
      row.capabilities.map((cap) =>
        prisma.connectorCapabilityState.upsert({
          where: {
            organisationId_providerKey_connectionRef_capability: {
              organisationId,
              providerKey: row.providerKey,
              connectionRef: row.connectionRef,
              capability: cap.capability,
            },
          },
          create: {
            organisationId,
            providerKey: row.providerKey,
            connectionRef: row.connectionRef,
            capability: cap.capability,
            status: cap.status,
            provenance: cap.provenance,
            missingScopes: cap.missingScopes,
            detail: cap.detail,
            lastEvaluatedAt: new Date(),
          },
          update: {
            status: cap.status,
            provenance: cap.provenance,
            missingScopes: cap.missingScopes,
            detail: cap.detail,
            lastEvaluatedAt: new Date(),
          },
        }),
      ),
    ),
  );

  return rows;
}

function mapSocialStatus(
  status: SocialConnectionStatus | undefined,
  expiresAt: Date | null,
): ConnectorConnectionStatus {
  if (!status) return ConnectorConnectionStatus.DISCONNECTED;
  if (status === SocialConnectionStatus.REVOKED) return ConnectorConnectionStatus.REVOKED;
  if (status === SocialConnectionStatus.ERROR) return ConnectorConnectionStatus.ERROR;
  if (status === SocialConnectionStatus.EXPIRED) return ConnectorConnectionStatus.EXPIRED;
  if (status === SocialConnectionStatus.PENDING) return ConnectorConnectionStatus.CONNECTING;
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    return ConnectorConnectionStatus.REAUTH_REQUIRED;
  }
  if (status === SocialConnectionStatus.ACTIVE) return ConnectorConnectionStatus.CONNECTED;
  return ConnectorConnectionStatus.DISCONNECTED;
}

function evaluateSocialCapability(input: {
  capability: ConnectorCapability;
  connectionStatus: ConnectorConnectionStatus;
  scopes: string[];
  required: string[];
  providerKey: string;
}): {
  capability: string;
  status: ConnectorCapabilityStatus;
  provenance: string;
  missingScopes: string[];
  detail?: string;
} {
  const { capability, connectionStatus, scopes, required, providerKey } = input;
  if (capability === "READ_PUBLIC_CONTENT") {
    return {
      capability,
      status: ConnectorCapabilityStatus.RESTRICTED,
      provenance: "public listen is provider-dependent (Apify path)",
      missingScopes: [],
    };
  }
  if (connectionStatus === ConnectorConnectionStatus.DISCONNECTED) {
    return {
      capability,
      status: ConnectorCapabilityStatus.AUTH_REQUIRED,
      provenance: "no SocialConnection",
      missingScopes: required,
    };
  }
  if (
    connectionStatus === ConnectorConnectionStatus.EXPIRED ||
    connectionStatus === ConnectorConnectionStatus.REAUTH_REQUIRED
  ) {
    return {
      capability,
      status: ConnectorCapabilityStatus.AUTH_REQUIRED,
      provenance: "token expired / reauth required",
      missingScopes: [],
    };
  }
  if (capability === "PUBLISH") {
    const missing = required.filter((s) => !scopes.includes(s) && !scopes.some((g) => g.includes(s)));
    // Soft check — providers often use opaque scope strings.
    if (scopes.length === 0) {
      return {
        capability,
        status: ConnectorCapabilityStatus.SCOPE_REQUIRED,
        provenance: "connection present but scopes empty",
        missingScopes: required,
      };
    }
    if (providerKey === "linkedin" && !scopes.some((s) => s.includes("w_member_social") || s.includes("openid"))) {
      return {
        capability,
        status: ConnectorCapabilityStatus.SCOPE_REQUIRED,
        provenance: "granted scopes recorded on connection",
        missingScopes: missing.length ? missing : ["w_member_social"],
      };
    }
    return {
      capability,
      status: ConnectorCapabilityStatus.CONNECTED,
      provenance: "SocialConnection ACTIVE + scopes recorded",
      missingScopes: [],
      detail: "Publish product E2E is Phase 15 (worker → adapter.publish)",
    };
  }
  if (capability === "READ_PROFILE" || capability === "READ_OWN_CONTENT" || capability === "READ_ANALYTICS") {
    return {
      capability,
      status:
        connectionStatus === ConnectorConnectionStatus.CONNECTED
          ? ConnectorCapabilityStatus.CONNECTED
          : ConnectorCapabilityStatus.DEGRADED,
      provenance: "derived from SocialConnection status",
      missingScopes: [],
    };
  }
  return {
    capability,
    status: ConnectorCapabilityStatus.UNSUPPORTED,
    provenance: "capability not implemented for this provider in Agent Desk",
    missingScopes: [],
  };
}

function toCustomerLabel(
  connectionStatus: ConnectorConnectionStatus,
  caps: Array<{ status: ConnectorCapabilityStatus }>,
): CustomerHealthLabel {
  if (
    connectionStatus === ConnectorConnectionStatus.REAUTH_REQUIRED ||
    connectionStatus === ConnectorConnectionStatus.EXPIRED
  ) {
    return "Reconnect";
  }
  if (
    connectionStatus === ConnectorConnectionStatus.ERROR ||
    connectionStatus === ConnectorConnectionStatus.REVOKED
  ) {
    return "Unavailable";
  }
  if (connectionStatus === ConnectorConnectionStatus.DISCONNECTED) {
    return "Unavailable";
  }
  if (
    connectionStatus === ConnectorConnectionStatus.DEGRADED ||
    caps.some((c) => c.status === ConnectorCapabilityStatus.DEGRADED)
  ) {
    return "Attention required";
  }
  if (caps.some((c) => c.status === ConnectorCapabilityStatus.SCOPE_REQUIRED)) {
    return "Limited";
  }
  if (connectionStatus === ConnectorConnectionStatus.CONNECTED) {
    return "Healthy";
  }
  return "Attention required";
}

export async function recordProviderHealth(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  status: ConnectorConnectionStatus;
  source: string;
  latencyMs?: number;
  errorCode?: string;
  summary?: string;
}) {
  await prisma.providerHealthEvent.create({
    data: {
      organisationId: input.organisationId,
      providerKey: input.providerKey,
      connectionRef: input.connectionRef ?? undefined,
      status: input.status,
      source: input.source,
      latencyMs: input.latencyMs,
      errorCode: input.errorCode,
      summary: input.summary,
    },
  });
  // Bound history: keep last 100 per org+provider.
  const old = await prisma.providerHealthEvent.findMany({
    where: {
      organisationId: input.organisationId,
      providerKey: input.providerKey,
    },
    orderBy: { observedAt: "desc" },
    skip: 100,
    select: { id: true },
  });
  if (old.length) {
    await prisma.providerHealthEvent.deleteMany({
      where: { id: { in: old.map((o) => o.id) } },
    });
  }
}
