import { MessagingExternalOutcome, Prisma, SuppressionReason } from "@prisma/client";
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
  "don't contact",
  "do not contact",
  "remove me",
  "stop messaging",
  "leave me alone",
];

/** Lowercase, straighten apostrophes, collapse spaces, drop punctuation/emoji at the edges. */
function normaliseOptOutText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Polite lead-ins that still leave a direct command: "please stop", "I'd like to unsubscribe". */
const OPT_OUT_LEAD_IN =
  /^(?:(?:please|pls|plz|kindly|just|ok|okay|no|can you|could you|would you|will you|i want to|i'd like to|i would like to|i wish to|i want you to|i need you to)(?![\p{L}\p{N}'])[\s,.!]*)+/u;

/** "stop by", "stop in" invite a visit — not a request to end the conversation. */
const VISIT_CONTINUATION = /^\s+(?:by|in|over|round|around)\b/;

/**
 * Return the opt-out keyword the message is a command for, or null.
 *
 * A keyword counts only when it is the whole message or the message starts with it
 * (after a polite lead-in) — "STOP", "stop messaging me", "please unsubscribe me".
 * An occurrence inside a sentence ("can't stop thinking about it", "non-stop",
 * "one-stop shop") is not an opt-out: it would hard-suppress the contact.
 */
export function matchOptOutKeyword(
  text: string,
  keywords: string[] = DEFAULT_OPT_OUT_KEYWORDS,
): string | null {
  const full = normaliseOptOutText(text);
  if (!full) return null;
  // Keep the un-stripped form too, so configured phrases like "no more messages" still match.
  const candidates = [...new Set([full, full.replace(OPT_OUT_LEAD_IN, "")])];
  for (const keyword of keywords) {
    const phrase = normaliseOptOutText(String(keyword ?? ""));
    if (!phrase) continue;
    for (const message of candidates) {
      if (!message.startsWith(phrase)) continue;
      const rest = message.slice(phrase.length);
      // Whole-word only: "stopping", "stop-loss", "unsubscribed" are not the command.
      if (/^[\p{L}\p{N}'-]/u.test(rest)) continue;
      if (VISIT_CONTINUATION.test(rest)) continue;
      return phrase;
    }
  }
  return null;
}

export function detectOptOut(text: string, keywords: string[] = DEFAULT_OPT_OUT_KEYWORDS): boolean {
  return matchOptOutKeyword(text, keywords) !== null;
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
    const current = await tx.contact.findFirst({
      where: { id: input.contactId, organisationId: input.organisationId },
      select: { metadata: true },
    });
    // Merge: replacing metadata wiped DO_NOT_CONTACT / origin flags set elsewhere.
    const existingMetadata =
      current?.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata)
        ? (current.metadata as Prisma.JsonObject)
        : {};
    await tx.contact.updateMany({
      where: { id: input.contactId, organisationId: input.organisationId },
      data: {
        optedOut: true,
        optedOutAt: new Date(),
        consentGiven: false,
        metadata: {
          ...existingMetadata,
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
  const now = new Date();
  const [, lifted] = await prisma.$transaction([
    prisma.contact.updateMany({
      where: { id: input.contactId, organisationId: input.organisationId },
      data: {
        optedOut: false,
        optedOutAt: null,
        consentGiven: true,
      },
    }),
    // Expire the OPT_OUT suppression applyOptOut created — contactability checks
    // suppressions before the human-reply bypass, so leaving it blocks every reply.
    prisma.contactSuppression.updateMany({
      where: {
        organisationId: input.organisationId,
        contactId: input.contactId,
        reason: SuppressionReason.OPT_OUT,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { expiresAt: now },
    }),
  ]);

  await writeAuditLog({
    organisationId: input.organisationId,
    userId: input.userId,
    action: "contact.opt_out_cleared",
    entityType: "Contact",
    entityId: input.contactId,
    metadata: { liftedSuppressions: lifted.count },
  });
}

export { DEFAULT_OPT_OUT_KEYWORDS };
