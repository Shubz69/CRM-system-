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

/** Validate header against env default and optional org override. */
export async function validateManyChatSecret(
  headerSecret: string,
  organisationId?: string | null,
): Promise<boolean> {
  const envSecret = getEnv().MANYCHAT_WEBHOOK_SECRET;
  if (secretsEqual(headerSecret, envSecret)) return true;
  if (!organisationId) return false;
  const orgSecret = await getOrganisationManyChatSecret(organisationId);
  return Boolean(orgSecret && secretsEqual(headerSecret, orgSecret));
}
