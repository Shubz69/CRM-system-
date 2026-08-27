import { IntegrationType } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";

const API_TOKEN_KEY = "api_token";

export type MessagingCredentialSource = "organisation" | "env" | "none" | "revoked";

async function readOrganisationCredential(organisationId: string): Promise<{
  token: string | null;
  connectionRef: string;
  active: boolean;
} | null> {
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
  if (!integration) return null;

  const connectionRef = `manychat:${integration.id}`;
  const credential = integration.credentials.find(
    (candidate) => candidate.keyName === API_TOKEN_KEY,
  );
  if (!credential) {
    return { token: null, connectionRef, active: integration.isActive };
  }
  try {
    return {
      token: decryptSecret(credential.encryptedValue),
      connectionRef,
      active: integration.isActive,
    };
  } catch {
    return { token: null, connectionRef, active: integration.isActive };
  }
}

export async function getOrganisationManyChatApiToken(
  organisationId: string,
): Promise<string | null> {
  const org = await readOrganisationCredential(organisationId);
  if (!org?.active || !org.token) return null;
  return org.token;
}

export async function setOrganisationManyChatApiToken(
  organisationId: string,
  token: string,
): Promise<void> {
  const value = token.trim();
  if (!value) throw new Error("ManyChat API token cannot be empty");

  const integration = await prisma.integration.upsert({
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
    update: { isActive: true },
  });
  const encryptedValue = encryptSecret(value);
  await prisma.integrationCredential.upsert({
    where: {
      integrationId_keyName: {
        integrationId: integration.id,
        keyName: API_TOKEN_KEY,
      },
    },
    create: { integrationId: integration.id, keyName: API_TOKEN_KEY, encryptedValue },
    update: { encryptedValue },
  });
}

/**
 * Resolve ManyChat send credentials for an organisation.
 * Prefer active org credential over env. Never cross-org.
 * If a prior dispatch bound an org connection that is now inactive → revoked
 * (do not silently fall back to env for that send).
 */
export async function resolveMessagingSendCredential(
  organisationId: string,
  options?: { preparedConnectionRef?: string },
): Promise<{
  token: string | null;
  source: MessagingCredentialSource;
  connectionRef: string | null;
}> {
  const organisation = await readOrganisationCredential(organisationId);
  const prepared = options?.preparedConnectionRef;

  if (prepared?.startsWith("manychat:")) {
    if (!organisation || organisation.connectionRef !== prepared) {
      // Prepared against a different/missing org connection — deny (no cross-org).
      return { token: null, source: "revoked", connectionRef: prepared };
    }
    if (!organisation.active || !organisation.token) {
      return { token: null, source: "revoked", connectionRef: prepared };
    }
    return {
      token: organisation.token,
      source: "organisation",
      connectionRef: organisation.connectionRef,
    };
  }

  if (organisation?.active && organisation.token) {
    return {
      token: organisation.token,
      source: "organisation",
      connectionRef: organisation.connectionRef,
    };
  }

  if (organisation && !organisation.active && organisation.token) {
    // Explicitly deactivated org connection — do not fall through to env for safety
    // when an org connection row exists but is revoked.
    return {
      token: null,
      source: "revoked",
      connectionRef: organisation.connectionRef,
    };
  }

  const token = getEnv().MANYCHAT_API_TOKEN?.trim();
  if (token) {
    return {
      token,
      source: "env",
      connectionRef: "env:MANYCHAT_API_TOKEN",
    };
  }
  return { token: null, source: "none", connectionRef: null };
}
