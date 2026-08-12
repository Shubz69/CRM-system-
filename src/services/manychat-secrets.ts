import { randomBytes, timingSafeEqual } from "crypto";
import { IntegrationType } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/db";

function secretsEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

const CREDENTIAL_KEY = "webhook_secret";

export function maskSecret(value: string | undefined | null): string {
  if (!value) return "not set";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export async function ensureManyChatIntegration(organisationId: string) {
  return prisma.integration.upsert({
    where: {
      organisationId_type_name: {
        organisationId,
        type: IntegrationType.MANYCHAT,
        name: "default",
      },
    },
    create: {
      organisationId,
      type: IntegrationType.MANYCHAT,
      name: "default",
      isActive: true,
      config: {},
    },
    update: {},
  });
}

export async function getOrganisationManyChatSecret(
  organisationId: string,
): Promise<string | null> {
  const integration = await prisma.integration.findUnique({
    where: {
      organisationId_type_name: {
        organisationId,
        type: IntegrationType.MANYCHAT,
        name: "default",
      },
    },
    include: { credentials: true },
  });
  const cred = integration?.credentials.find((c) => c.keyName === CREDENTIAL_KEY);
  if (!cred) return null;
  try {
    return decryptSecret(cred.encryptedValue);
  } catch {
    return null;
  }
}

export async function resolveManyChatWebhookSecret(
  organisationId?: string | null,
): Promise<{ secret: string; source: "env" | "organisation" }> {
  if (organisationId) {
    const orgSecret = await getOrganisationManyChatSecret(organisationId);
    if (orgSecret) return { secret: orgSecret, source: "organisation" };
  }
  return { secret: getEnv().MANYCHAT_WEBHOOK_SECRET, source: "env" };
}

export async function regenerateOrganisationManyChatSecret(organisationId: string) {
  const integration = await ensureManyChatIntegration(organisationId);
  const secret = `mc_${randomBytes(24).toString("hex")}`;
  await prisma.integrationCredential.upsert({
    where: {
      integrationId_keyName: {
        integrationId: integration.id,
        keyName: CREDENTIAL_KEY,
      },
    },
    create: {
      integrationId: integration.id,
      keyName: CREDENTIAL_KEY,
      encryptedValue: encryptSecret(secret),
    },
    update: {
      encryptedValue: encryptSecret(secret),
    },
  });
  await prisma.integration.update({
    where: { id: integration.id },
    data: { isActive: true, updatedAt: new Date() },
  });
  return secret;
}

/** Org-scoped secret only — never accepts the global env secret. */
export async function validateOrgScopedManyChatSecret(
  headerSecret: string,
  organisationId: string,
): Promise<boolean> {
  if (!headerSecret || !organisationId) return false;
  const orgSecret = await getOrganisationManyChatSecret(organisationId);
  return Boolean(orgSecret && secretsEqual(headerSecret, orgSecret));
}

export type ManyChatOrgResolution =
  | {
      ok: true;
      organisationId: string;
      channelExternalId?: string;
      authMethod: "channel_mapping" | "org_scoped_secret" | "demo";
    }
  | { ok: false; status: number; error: string };

/**
 * Resolve which organisation a ManyChat webhook may write into.
 *
 * Rules:
 * - Never trust payload organisationId as authoritative on its own.
 * - Global env secret may only authorize writes when org is proven via a
 *   unique MessagingChannel mapping (channel_id).
 * - Without a unique channel mapping, only an org-scoped secret is accepted
 *   (payload organisationId is merely the lookup key for that secret).
 */
export async function resolveManyChatWebhookOrganisation(input: {
  secretHeader: string;
  payloadOrganisationId?: string | null;
  channelExternalId?: string | null;
  allowDemoFallback?: boolean;
}): Promise<ManyChatOrgResolution> {
  const envSecret = getEnv().MANYCHAT_WEBHOOK_SECRET;
  const secretHeader = input.secretHeader || "";
  const channelExternalId = input.channelExternalId || undefined;
  const payloadOrganisationId = input.payloadOrganisationId || undefined;

  if (channelExternalId) {
    const matches = await prisma.messagingChannel.findMany({
      where: { provider: "manychat", externalId: channelExternalId, isActive: true },
      take: 5,
    });
    if (matches.length > 1) {
      return {
        ok: false,
        status: 400,
        error: "channel_id maps to multiple organisations; cannot resolve tenant safely",
      };
    }
    if (matches.length === 1) {
      const organisationId = matches[0]!.organisationId;
      const orgSecret = await getOrganisationManyChatSecret(organisationId);
      const orgOk = Boolean(orgSecret && secretsEqual(secretHeader, orgSecret));
      const envOk = secretsEqual(secretHeader, envSecret);
      if (!orgOk && !envOk) {
        return { ok: false, status: 401, error: "Invalid webhook secret" };
      }
      return {
        ok: true,
        organisationId,
        channelExternalId,
        authMethod: "channel_mapping",
      };
    }
  }

  // No unique channel mapping — global secret must NOT authorize arbitrary org claims.
  if (!payloadOrganisationId) {
    if (input.allowDemoFallback) {
      const org = await prisma.organisation.findFirst({
        where: { deletedAt: null, demoData: true },
        orderBy: { createdAt: "asc" },
      });
      if (org && secretsEqual(secretHeader, envSecret)) {
        return {
          ok: true,
          organisationId: org.id,
          channelExternalId: channelExternalId ?? "default",
          authMethod: "demo",
        };
      }
    }
    return {
      ok: false,
      status: 401,
      error: "Org-scoped secret or verified channel_id required",
    };
  }

  const orgOk = await validateOrgScopedManyChatSecret(secretHeader, payloadOrganisationId);
  if (!orgOk) {
    // Explicitly reject global-secret + payload orgId (cross-tenant write vector).
    return {
      ok: false,
      status: 401,
      error:
        "Invalid webhook secret — global secret cannot authorize a payload organisationId; use an org-scoped secret or channel_id mapping",
    };
  }

  return {
    ok: true,
    organisationId: payloadOrganisationId,
    channelExternalId,
    authMethod: "org_scoped_secret",
  };
}

/**
 * @deprecated Prefer resolveManyChatWebhookOrganisation — env secret alone must not
 * authorize arbitrary organisationId claims.
 */
export async function validateManyChatSecret(
  headerSecret: string,
  organisationId?: string | null,
): Promise<boolean> {
  if (!organisationId) return false;
  return validateOrgScopedManyChatSecret(headerSecret, organisationId);
}
