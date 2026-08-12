import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { writeAuditLog } from "@/services/audit";
import { cancelFollowUpsOnOptOut } from "@/services/followups";

const DEFAULT_OPT_OUT_KEYWORDS = [
  "stop",
  "unsubscribe",
  "opt out",
  "opt-out",
  "don't message",
  "do not message",
  "remove me",
  "stop messaging",
];

export function detectOptOut(text: string, keywords: string[] = DEFAULT_OPT_OUT_KEYWORDS): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

export async function applyOptOut(input: {
  organisationId: string;
  contactId: string;
  source: string;
  userId?: string;
  reason?: string;
}): Promise<void> {
  await prisma.contact.updateMany({
    where: { id: input.contactId, organisationId: input.organisationId },
    data: {
      optedOut: true,
      optedOutAt: new Date(),
      consentGiven: false,
      metadata: {
        optOutSource: input.source,
        optOutReason: input.reason ?? null,
      },
    },
  });

  const cancelled = await cancelFollowUpsOnOptOut({
    organisationId: input.organisationId,
    contactId: input.contactId,
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.userId,
    action: "contact.opted_out",
    entityType: "Contact",
    entityId: input.contactId,
    metadata: { source: input.source, cancelledFollowUps: cancelled },
  });

  logger.info("Contact opted out", {
    organisationId: input.organisationId,
    contactId: input.contactId,
    source: input.source,
  });
}

export async function clearOptOut(input: {
  organisationId: string;
  contactId: string;
  userId: string;
}): Promise<void> {
  await prisma.contact.updateMany({
    where: { id: input.contactId, organisationId: input.organisationId },
    data: {
      optedOut: false,
      optedOutAt: null,
      consentGiven: true,
    },
  });

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.userId,
    action: "contact.opt_out_cleared",
    entityType: "Contact",
    entityId: input.contactId,
  });
}

export { DEFAULT_OPT_OUT_KEYWORDS };
