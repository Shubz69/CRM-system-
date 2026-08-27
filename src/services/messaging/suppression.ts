import { Prisma, SuppressionReason } from "@prisma/client";
import { prisma } from "@/lib/db";

export type SuppressContactInput = {
  organisationId: string;
  contactId: string;
  reason: SuppressionReason;
  source: string;
  channel?: string;
  provider?: string;
  createdByUserId?: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
};

export async function suppressContact(input: SuppressContactInput) {
  const now = new Date();
  const existing = await prisma.contactSuppression.findFirst({
    where: {
      organisationId: input.organisationId,
      contactId: input.contactId,
      channel: input.channel ?? null,
      reason: input.reason,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  return prisma.contactSuppression.create({
    data: {
      organisationId: input.organisationId,
      contactId: input.contactId,
      reason: input.reason,
      source: input.source,
      channel: input.channel,
      provider: input.provider,
      createdByUserId: input.createdByUserId,
      expiresAt: input.expiresAt,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export async function listActiveSuppressions(input: {
  organisationId: string;
  contactId?: string;
  channel?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return prisma.contactSuppression.findMany({
    where: {
      organisationId: input.organisationId,
      contactId: input.contactId,
      ...(input.channel
        ? { OR: [{ channel: null }, { channel: input.channel }] }
        : {}),
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function isContactSuppressed(
  organisationId: string,
  contactId: string,
  channel?: string,
): Promise<boolean> {
  const suppression = await prisma.contactSuppression.findFirst({
    where: {
      organisationId,
      contactId,
      ...(channel ? { OR: [{ channel: null }, { channel }] } : {}),
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
    },
    select: { id: true },
  });
  return Boolean(suppression);
}

export { SuppressionReason };
