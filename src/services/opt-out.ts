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
  "stop messaging",
  "stop texting",
  "stop contacting",
  "stop sending",
  "stop emailing",
  "stop dming",
  "don't message",
  "do not message",
  "don't contact",
  "do not contact",
  "remove me",
  "leave me alone",
  "no more messages",
  "take me off",
];

/**
 * Split a message into lowercase clauses: emoji/symbols dropped, apostrophes straightened,
 * hyphens inside words become spaces ("opt-out" → "opt out", "non-stop" → "non stop"), and
 * sentence punctuation, spaced dashes, newlines and " but " separate clauses.
 */
function optOutClauses(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'")
    .replace(/\s[-\u2010-\u2015]+\s|[\u2013-\u2015]/g, "\n")
    .replace(/[.,!?;:\u2026\r\n]+/g, "\n")
    .replace(/[^\p{L}\p{N}'\n]+/gu, " ")
    // Apostrophes only survive inside words ("don't"); quote marks around a word do not.
    .replace(/(?<![\p{L}\p{N}])'+|'+(?![\p{L}\p{N}])/gu, " ")
    .replace(/(?<![\p{L}\p{N}'])dont(?![\p{L}\p{N}'])/gu, "don't")
    .split(/\n|\s+but\s+/)
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function normaliseKeyword(keyword: unknown): string {
  return optOutClauses(String(keyword ?? "")).join(" ");
}

/**
 * A bare "stop" is an opt-out only when it is a clause of its own once filler is removed:
 * "STOP", "Hi, stop", "I said STOP", "No thanks.\nStop it now". Never "can't stop thinking
 * about it", "the bus stop", "don't stop", "stop by later" or "one-stop shop".
 */
const BARE_STOP_WORDS = new Set(["stop", "stopp", "stahp"]);
const STOP_LEAD_IN =
  "hi|hey|hello|ok|okay|k|no|nope|nah|but|and|ugh|omg|thanks|thank you|thx|please|pls|plz|" +
  "kindly|just|seriously|i said|i said to|i told you|i told you to|now|so|can you|could you|" +
  "would you|will you|i want you to|i need you to|i'd like you to|i would like you to";
const STOP_SUFFIX =
  "it|this|now|please|pls|plz|already|all|thanks|thank you|messaging|texting|" +
  "messaging me|texting me|contacting me|emailing me|dming me|spamming me";
const STOP_CLAUSE = new RegExp(`^(?:(?:${STOP_LEAD_IN}) )*(?:stop+|stahp)(?: (?:${STOP_SUFFIX}))*$`);

/**
 * Phrases match anywhere as whole words, except straight after a negation aimed at them:
 * "please don't remove me", "I don't want to unsubscribe", "don't stop sending me updates".
 */
const NEGATED_BEFORE =
  /(?:^| )(?:don't|do not|didn't|did not|never|not|no need to|(?:i|we) (?:can't|cannot|can not|couldn't))(?: (?:want|wanna|need|mean|plan|intend|wish|like)(?: to)?)?(?: you to| to)?$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseMatches(clause: string, phrase: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}'])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}'])`, "gu");
  for (const match of clause.matchAll(pattern)) {
    if (!NEGATED_BEFORE.test(clause.slice(0, match.index).trimEnd())) return true;
  }
  return false;
}

/**
 * Return the opt-out keyword the message contains as a command, or null.
 *
 * - Bare "stop" (also "stopp" / "stahp") counts only as a clause of its own after filler
 *   ("STOP", "Hi, stop", "I said STOP", "No thanks.\nStop") — never inside a sentence
 *   ("can't stop thinking about it", "non-stop", "can you stop by tomorrow?").
 * - Multi-word phrases ("stop messaging", "remove me", "opt out", "leave me alone") and other
 *   single words ("unsubscribe") match anywhere as whole words, so "Not interested, please
 *   stop messaging me" and "Thanks but remove me" opt out.
 *
 * Org-configured keywords follow the same rules. An opt-out hard-suppresses the contact,
 * so the bare-"stop" rule stays strict.
 */
export function matchOptOutKeyword(
  text: string,
  keywords: string[] = DEFAULT_OPT_OUT_KEYWORDS,
): string | null {
  const clauses = optOutClauses(String(text ?? ""));
  if (!clauses.length) return null;
  for (const keyword of keywords) {
    const phrase = normaliseKeyword(keyword);
    if (!phrase) continue;
    const matched = BARE_STOP_WORDS.has(phrase)
      ? clauses.some((clause) => STOP_CLAUSE.test(clause))
      : clauses.some((clause) => phraseMatches(clause, phrase));
    if (matched) return phrase;
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
