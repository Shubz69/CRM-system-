import { IntegrationType } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";

const API_TOKEN_KEY = "api_token";

export type MessagingCredentialSource = "organisation" | "env" | "none" | "revoked";

export type ManyChatApiTokenSaveResult = {
  /** True when an existing org credential ciphertext was replaced. */
  rotated: boolean;
  connectionRef: string;
  /** Never includes plaintext — UI status only. */
  apiTokenStatus: "Configured";
};

export type ManyChatConnectionState = {
  exists: boolean;
  isActive: boolean;
  /** Decryptable org credential present (independent of isActive). */
  hasStoredApiToken: boolean;
  connectionRef: string | null;
};

async function readOrganisationCredential(organisationId: string): Promise<{
  token: string | null;
  connectionRef: string;
  active: boolean;
  credentialId: string | null;
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
    return { token: null, connectionRef, active: integration.isActive, credentialId: null };
  }
  try {
    return {
      token: decryptSecret(credential.encryptedValue),
      connectionRef,
      active: integration.isActive,
      credentialId: credential.id,
    };
  } catch {
    return {
      token: null,
      connectionRef,
      active: integration.isActive,
      credentialId: credential.id,
    };
  }
}

/** Connection metadata for UI — never returns ciphertext or plaintext. */
export async function getOrganisationManyChatConnectionState(
  organisationId: string,
): Promise<ManyChatConnectionState> {
  const org = await readOrganisationCredential(organisationId);
  if (!org) {
    return { exists: false, isActive: false, hasStoredApiToken: false, connectionRef: null };
  }
  return {
    exists: true,
    isActive: org.active,
    hasStoredApiToken: Boolean(org.token),
    connectionRef: org.connectionRef,
  };
}

export async function getOrganisationManyChatApiToken(
  organisationId: string,
): Promise<string | null> {
  const org = await readOrganisationCredential(organisationId);
  if (!org?.active || !org.token) return null;
  return org.token;
}

/**
 * Store (or rotate) the org ManyChat API token.
 * Ciphertext only — callers must never echo the plaintext back to clients.
 * Rotation supersedes the prior credential value in place and stamps lastRotatedAt.
 */
export async function setOrganisationManyChatApiToken(
  organisationId: string,
  token: string,
): Promise<ManyChatApiTokenSaveResult> {
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

  const existing = await prisma.integrationCredential.findUnique({
    where: {
      integrationId_keyName: {
        integrationId: integration.id,
        keyName: API_TOKEN_KEY,
      },
    },
  });

  const encryptedValue = encryptSecret(value);
  const rotated = Boolean(existing?.encryptedValue);

  await prisma.integrationCredential.upsert({
    where: {
      integrationId_keyName: {
        integrationId: integration.id,
        keyName: API_TOKEN_KEY,
      },
    },
    create: {
      integrationId: integration.id,
      keyName: API_TOKEN_KEY,
      encryptedValue,
      healthStatus: "UNKNOWN",
    },
    update: {
      encryptedValue,
      lastRotatedAt: new Date(),
      healthStatus: "UNKNOWN",
      healthNote: rotated ? "Superseded by operator token rotation" : null,
    },
  });

  return {
    rotated,
    connectionRef: `manychat:${integration.id}`,
    apiTokenStatus: "Configured",
  };
}

/**
 * Disconnect ManyChat for the organisation.
 * Sets isActive=false, marks API credential REVOKED, keeps ciphertext so history
 * and a later reconnect (with valid stored credential) remain possible.
 * Does not delete conversations or messages.
 */
export async function disconnectOrganisationManyChat(
  organisationId: string,
): Promise<{ connectionRef: string }> {
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
  if (!integration) {
    throw new Error("ManyChat is not connected for this organisation");
  }

  await prisma.integration.update({
    where: { id: integration.id },
    data: { isActive: false },
  });

  const credential = integration.credentials.find((c) => c.keyName === API_TOKEN_KEY);
  if (credential) {
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: {
        healthStatus: "REVOKED",
        healthNote: "Disconnected by operator — outbound blocked",
      },
    });
  }

  return { connectionRef: `manychat:${integration.id}` };
}

/**
 * Reconnect ManyChat. Requires a decryptable stored API token (save/rotate first if missing).
 */
export async function reconnectOrganisationManyChat(
  organisationId: string,
): Promise<{ connectionRef: string }> {
  const org = await readOrganisationCredential(organisationId);
  if (!org) {
    throw new Error("ManyChat is not set up — save an API token first");
  }
  if (!org.token) {
    throw new Error("Reconnect requires a valid API token — save a token first");
  }

  await prisma.integration.update({
    where: {
      organisationId_type_name: {
        organisationId,
        type: IntegrationType.MANYCHAT,
        name: "default",
      },
    },
    data: { isActive: true },
  });

  if (org.credentialId) {
    await prisma.integrationCredential.update({
      where: { id: org.credentialId },
      data: {
        healthStatus: "UNKNOWN",
        healthNote: "Reconnected by operator",
      },
    });
  }

  return { connectionRef: org.connectionRef };
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

  // Org row exists, inactive, but no decryptable token — still treat as revoked
  // so disconnect without a readable token cannot silently use env.
  if (organisation && !organisation.active) {
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
