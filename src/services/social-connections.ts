import { SocialConnectionStatus, SocialPlatform } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import type { SocialCapabilities } from "@/adapters/social/types";

const ACCESS_TOKEN_KEY = "access_token";
const REFRESH_TOKEN_KEY = "refresh_token";

export type UpsertSocialConnectionInput = {
  organisationId: string;
  platform: SocialPlatform;
  externalAccountId: string;
  displayName?: string;
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  scopes: string[];
  capabilities: SocialCapabilities;
  connectedByUserId: string;
};

/** Create or refresh a tenant's connection to a platform + store its encrypted tokens. */
export async function upsertSocialConnection(input: UpsertSocialConnectionInput) {
  const expiresAt = input.expiresInSeconds
    ? new Date(Date.now() + input.expiresInSeconds * 1000)
    : null;

  const connection = await prisma.socialConnection.upsert({
    where: {
      organisationId_platform_externalAccountId: {
        organisationId: input.organisationId,
        platform: input.platform,
        externalAccountId: input.externalAccountId,
      },
    },
    create: {
      organisationId: input.organisationId,
      platform: input.platform,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
      status: SocialConnectionStatus.ACTIVE,
      scopes: input.scopes,
      capabilities: input.capabilities,
      connectedByUserId: input.connectedByUserId,
      expiresAt,
      lastSyncedAt: new Date(),
    },
    update: {
      displayName: input.displayName,
      status: SocialConnectionStatus.ACTIVE,
      scopes: input.scopes,
      capabilities: input.capabilities,
      connectedByUserId: input.connectedByUserId,
      expiresAt,
      lastSyncedAt: new Date(),
    },
  });

  await storeConnectionToken(connection.id, ACCESS_TOKEN_KEY, input.accessToken);
  if (input.refreshToken) {
    await storeConnectionToken(connection.id, REFRESH_TOKEN_KEY, input.refreshToken);
  }

  return connection;
}

export async function storeConnectionToken(
  socialConnectionId: string,
  keyName: string,
  plaintext: string,
) {
  return prisma.socialConnectionCredential.upsert({
    where: { socialConnectionId_keyName: { socialConnectionId, keyName } },
    create: { socialConnectionId, keyName, encryptedValue: encryptSecret(plaintext) },
    update: { encryptedValue: encryptSecret(plaintext) },
  });
}

export async function getConnectionToken(
  socialConnectionId: string,
  keyName: string,
): Promise<string | null> {
  const cred = await prisma.socialConnectionCredential.findUnique({
    where: { socialConnectionId_keyName: { socialConnectionId, keyName } },
  });
  if (!cred) return null;
  try {
    return decryptSecret(cred.encryptedValue);
  } catch {
    return null;
  }
}

export function getConnectionAccessToken(socialConnectionId: string) {
  return getConnectionToken(socialConnectionId, ACCESS_TOKEN_KEY);
}

export function getConnectionRefreshToken(socialConnectionId: string) {
  return getConnectionToken(socialConnectionId, REFRESH_TOKEN_KEY);
}

export async function listSocialConnections(organisationId: string) {
  return prisma.socialConnection.findMany({
    where: { organisationId },
    orderBy: { platform: "asc" },
  });
}

/** Revoke locally (delete tokens + mark REVOKED). Does not call the platform's revoke endpoint. */
export async function disconnectSocialConnection(organisationId: string, connectionId: string) {
  const connection = await prisma.socialConnection.findFirst({
    where: { id: connectionId, organisationId },
  });
  if (!connection) return null;

  await prisma.socialConnectionCredential.deleteMany({
    where: { socialConnectionId: connectionId },
  });
  return prisma.socialConnection.update({
    where: { id: connectionId },
    data: { status: SocialConnectionStatus.REVOKED },
  });
}
