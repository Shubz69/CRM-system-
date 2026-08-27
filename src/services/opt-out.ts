import { MessagingExternalOutcome, SuppressionReason } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { writeAuditLog } from "@/services/audit";
import { appendDomainEvent } from "@/services/domain-events/append";
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
  conversationId?: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.contact.updateMany({
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
    await tx.contactSuppression.create({
      data: {
        organisationId: input.organisationId,
        contactId: input.contactId,
        reason: SuppressionReason.OPT_OUT,
        source: input.source,
        createdByUserId: input.userId,
        metadata: { reason: input.reason ?? null },
      },
    });
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "CONTACT_OPTED_OUT",
      aggregateType: "Contact",
      aggregateId: input.contactId,
      payload: {
        contactId: input.contactId,
      },
      actorType: input.userId ? "USER" : "SYSTEM",
      actorId: input.userId,
      dedupeKey: `CONTACT_OPTED_OUT:${input.contactId}`,
    });
    if (input.conversationId) {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "CONVERSATION_OPTED_OUT",
        aggregateType: "Conversation",
        aggregateId: input.conversationId,
        payload: {
          conversationId: input.conversationId,
          contactId: input.contactId,
        },
        actorType: input.userId ? "USER" : "SYSTEM",
        actorId: input.userId,
        dedupeKey: `conversation-opted-out:${input.conversationId}`,
      });
    }
  });

  await prisma.outboundDispatch.updateMany({
    where: {
      organisationId: input.organisationId,
      contactId: input.contactId,
      externalOutcome: {
        in: [
          MessagingExternalOutcome.PREPARED,
          MessagingExternalOutcome.DISPATCHING,
          MessagingExternalOutcome.NOT_STARTED,
        ],
      },
    },
    data: {
      externalOutcome: MessagingExternalOutcome.FAILED,
      failureCode: "OPT_OUT",
      staleCancelled: true,
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
