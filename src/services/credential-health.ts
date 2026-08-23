/**
 * Credential health surface — never returns secret values.
 * Rotation is operator-driven; see docs/CREDENTIAL-ROTATION.md.
 */

import { prisma } from "@/lib/db";

export type CredentialHealthRow = {
  kind: "integration" | "social";
  id: string;
  keyName: string;
  healthStatus: string;
  healthNote: string | null;
  lastVerifiedAt: string | null;
  lastRotatedAt: string | null;
  /** Parent label — integration type/name or social platform */
  parentLabel: string;
  /** Never includes ciphertext */
  hasCiphertext: boolean;
};

export async function listCredentialHealth(organisationId: string): Promise<{
  credentials: CredentialHealthRow[];
  limitations: string[];
}> {
  const [integrations, social] = await Promise.all([
    prisma.integration.findMany({
      where: { organisationId },
      include: { credentials: true },
    }),
    prisma.socialConnection.findMany({
      where: { organisationId },
      include: { credentials: true },
    }),
  ]);

  const credentials: CredentialHealthRow[] = [];

  for (const integ of integrations) {
    for (const c of integ.credentials) {
      credentials.push({
        kind: "integration",
        id: c.id,
        keyName: c.keyName,
        healthStatus: c.healthStatus,
        healthNote: c.healthNote,
        lastVerifiedAt: c.lastVerifiedAt?.toISOString() ?? null,
        lastRotatedAt: c.lastRotatedAt?.toISOString() ?? null,
        parentLabel: `${integ.type}:${integ.name}`,
        hasCiphertext: Boolean(c.encryptedValue),
      });
    }
  }

  for (const conn of social) {
    for (const c of conn.credentials) {
      credentials.push({
        kind: "social",
        id: c.id,
        keyName: c.keyName,
        healthStatus: c.healthStatus,
        healthNote: c.healthNote,
        lastVerifiedAt: c.lastVerifiedAt?.toISOString() ?? null,
        lastRotatedAt: c.lastRotatedAt?.toISOString() ?? null,
        parentLabel: `${conn.platform}:${conn.displayName || conn.externalAccountId}`,
        hasCiphertext: Boolean(c.encryptedValue),
      });
    }
  }

  return {
    credentials,
    limitations: [
      "Health status is operator/metadata — not live provider probes unless lastVerifiedAt is set by a connection test.",
      "Ciphertext is never returned. Rotating ENCRYPTION_KEY requires a designed re-encrypt migration.",
      "Code cannot confirm that secrets were rotated in Vercel/provider consoles.",
    ],
  };
}

export async function markCredentialRotated(input: {
  organisationId: string;
  kind: "integration" | "social";
  credentialId: string;
  note?: string;
}): Promise<void> {
  if (input.kind === "integration") {
    const row = await prisma.integrationCredential.findFirst({
      where: {
        id: input.credentialId,
        integration: { organisationId: input.organisationId },
      },
    });
    if (!row) throw new Error("Credential not found");
    await prisma.integrationCredential.update({
      where: { id: row.id },
      data: {
        lastRotatedAt: new Date(),
        healthStatus: "UNKNOWN",
        healthNote: input.note ?? "Operator recorded rotation",
      },
    });
    return;
  }

  const row = await prisma.socialConnectionCredential.findFirst({
    where: {
      id: input.credentialId,
      socialConnection: { organisationId: input.organisationId },
    },
  });
  if (!row) throw new Error("Credential not found");
  await prisma.socialConnectionCredential.update({
    where: { id: row.id },
    data: {
      lastRotatedAt: new Date(),
      healthStatus: "UNKNOWN",
      healthNote: input.note ?? "Operator recorded rotation",
    },
  });
}
