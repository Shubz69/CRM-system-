/**
 * Canonical durable outbound messaging dispatch.
 * All consequential production sends must enter here — not the adapter directly.
 */

import {
  HandlingMode,
  MessageDirection,
  MessageSenderType,
  MessagingExternalOutcome,
  Prisma,
} from "@prisma/client";
import { getMessagingAdapterForOrganisation } from "@/adapters/messaging";
import { prisma } from "@/lib/db";
import { appendDomainEvent } from "@/services/domain-events/append";
import {
  assertContactable,
  ContactabilityError,
  type ContactabilityActionType,
} from "@/services/messaging/contactability";
import { resolveMessagingSendCredential } from "@/services/messaging/credentials";

const LEASE_MS = 30_000;

export type OutboundSource =
  | "HUMAN"
  | "AI"
  | "FOLLOW_UP"
  | "AUTOMATION"
  | "MISSION"
  | "REACTIVATION";

export type DispatchOutboundInput = {
  organisationId: string;
  conversationId: string;
  contactId: string;
  contactExternalId: string;
  content: string;
  source: OutboundSource;
  idempotencyKey: string;
  /** Lease holder — defaults from source + conversationId. */
  holder?: string;
  actorId?: string;
  provider?: string;
  threadId?: string;
  agentVersion?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
  /**
   * Optional client-supplied activity version for replay protection.
   * HUMAN ignores mid-flight version drift (human is authoritative);
   * automated sources treat mismatch as STALE_CONTEXT.
   */
  expectedActivityVersion?: number;
};

export type DispatchOutboundResult =
  | {
      ok: true;
      code: "CONFIRMED" | "ALREADY_CONFIRMED" | "IDEMPOTENT_RACE";
      dispatch: { id: string; messageId?: string | null; externalOutcome: string; [key: string]: unknown };
    }
  | {
      ok: false;
      code: string;
      dispatch?: { id: string; externalOutcome: string; [key: string]: unknown } | null;
    };

function sourceToActionType(source: OutboundSource): ContactabilityActionType {
  switch (source) {
    case "HUMAN":
      return "HUMAN_REPLY";
    case "FOLLOW_UP":
      return "FOLLOW_UP";
    case "AI":
      return "AI_REPLY";
    default:
      return "AUTOMATED_REPLY";
  }
}

function sourceToSenderType(source: OutboundSource): MessageSenderType {
  switch (source) {
    case "HUMAN":
      return MessageSenderType.HUMAN;
    case "AI":
      return MessageSenderType.AI;
    default:
      return MessageSenderType.SYSTEM;
  }
}

function defaultHolder(source: OutboundSource, conversationId: string): string {
  return `${source.toLowerCase()}:${conversationId}`;
}

async function acquireLease(input: {
  organisationId: string;
  conversationId: string;
  holder: string;
  /** Human may preempt automated leases. */
  preempt: boolean;
  expectedLastMessageId: string | null;
  expectedActivityVersion: number;
}): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const leaseData = {
    holder: input.holder,
    expectedLastMessageId: input.expectedLastMessageId,
    expectedActivityVersion: input.expectedActivityVersion,
    expiresAt,
  };

  const existing = await prisma.conversationSendLease.findUnique({
    where: { conversationId: input.conversationId },
  });

  if (existing) {
    if (input.preempt) {
      const forced = await prisma.conversationSendLease.updateMany({
        where: {
          conversationId: input.conversationId,
          organisationId: input.organisationId,
        },
        data: leaseData,
      });
      return forced.count === 1;
    }
    const updated = await prisma.conversationSendLease.updateMany({
      where: {
        conversationId: input.conversationId,
        organisationId: input.organisationId,
        OR: [{ holder: input.holder }, { expiresAt: { lte: now } }],
      },
      data: leaseData,
    });
    return updated.count === 1;
  }

  try {
    await prisma.conversationSendLease.create({
      data: {
        organisationId: input.organisationId,
        conversationId: input.conversationId,
        ...leaseData,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      if (!input.preempt) return false;
      const forced = await prisma.conversationSendLease.updateMany({
        where: {
          conversationId: input.conversationId,
          organisationId: input.organisationId,
        },
        data: leaseData,
      });
      return forced.count === 1;
    }
    throw error;
  }
}

async function releaseLease(conversationId: string, holder: string): Promise<void> {
  await prisma.conversationSendLease.deleteMany({
    where: { conversationId, holder },
  });
}

async function markDispatchFailed(input: {
  dispatchId: string;
  organisationId: string;
  conversationId: string;
  outcome: MessagingExternalOutcome;
  failureCode: string;
  providerError?: string | null;
  metadata?: Prisma.InputJsonValue;
  emitFailedEvent?: boolean;
}) {
  const dispatch = await prisma.outboundDispatch.update({
    where: { id: input.dispatchId },
    data: {
      externalOutcome: input.outcome,
      failureCode: input.failureCode,
      providerError: input.providerError ?? undefined,
      staleCancelled: input.failureCode === "STALE_CONTEXT" || input.failureCode === "OPT_OUT",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });

  if (input.emitFailedEvent) {
    await prisma.$transaction(async (tx) => {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "MESSAGE_FAILED",
        aggregateType: "Conversation",
        aggregateId: input.conversationId,
        payload: {
          conversationId: input.conversationId,
          failureCode: input.failureCode,
        },
        dedupeKey: `MESSAGE_FAILED:${input.dispatchId}:${input.failureCode}`,
      });
    });
  }

  return dispatch;
}

/**
 * Single canonical outbound entry point for consequential messaging.
 */
export async function dispatchOutboundMessage(
  input: DispatchOutboundInput,
): Promise<DispatchOutboundResult> {
  const source = input.source;
  const holder = input.holder ?? defaultHolder(source, input.conversationId);
  const provider = input.provider ?? "manychat";
  const channel = input.channel ?? "manychat";
  const actionType = sourceToActionType(source);
  const text = input.content;

  const existing = await prisma.outboundDispatch.findUnique({
    where: {
      organisationId_idempotencyKey: {
        organisationId: input.organisationId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing?.externalOutcome === MessagingExternalOutcome.CONFIRMED) {
    return { ok: true as const, code: "ALREADY_CONFIRMED" as const, dispatch: existing };
  }
  if (existing?.externalOutcome === MessagingExternalOutcome.DISPATCHING) {
    // Provider may have accepted the message — never blindly retry.
    const dispatch = await prisma.outboundDispatch.update({
      where: { id: existing.id },
      data: {
        externalOutcome: MessagingExternalOutcome.RECONCILIATION_REQUIRED,
        failureCode: "INTERRUPTED_DURING_DISPATCH",
      },
    });
    return { ok: false as const, code: "RECONCILIATION_REQUIRED" as const, dispatch };
  }
  if (
    existing?.externalOutcome === MessagingExternalOutcome.RECONCILIATION_REQUIRED ||
    existing?.externalOutcome === MessagingExternalOutcome.FAILED
  ) {
    return { ok: false as const, code: existing.externalOutcome, dispatch: existing };
  }

  // Gate #1 — before PREPARED
  try {
    await assertContactable({
      organisationId: input.organisationId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      channel,
      actionType,
    });
  } catch (error) {
    if (error instanceof ContactabilityError) {
      return { ok: false as const, code: error.code };
    }
    throw error;
  }

  const conversation = await prisma.conversation.findFirst({
    where: {
      id: input.conversationId,
      organisationId: input.organisationId,
      contactId: input.contactId,
      deletedAt: null,
    },
    select: {
      activityVersion: true,
      messages: {
        orderBy: { sentAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  if (!conversation) {
    return { ok: false as const, code: "CONVERSATION_NOT_FOUND" as const };
  }

  const expectedLastMessageId = conversation.messages[0]?.id ?? null;
  const expectedActivityVersion =
    input.expectedActivityVersion ?? conversation.activityVersion;

  // Optional client replay protection for HUMAN: reject if request carries a stale version.
  if (
    source === "HUMAN" &&
    input.expectedActivityVersion != null &&
    input.expectedActivityVersion !== conversation.activityVersion
  ) {
    return { ok: false as const, code: "STALE_CONTEXT" as const };
  }

  // Capture connection binding at PREPARE so revoke-after-prepare can be detected.
  const prepareCredential = await resolveMessagingSendCredential(input.organisationId, {
    provider,
  });

  let dispatch = existing;
  if (!dispatch) {
    try {
      dispatch = await prisma.outboundDispatch.create({
        data: {
          organisationId: input.organisationId,
          conversationId: input.conversationId,
          contactId: input.contactId,
          provider,
          holder,
          idempotencyKey: input.idempotencyKey,
          externalOutcome: MessagingExternalOutcome.PREPARED,
          expectedLastMessageId,
          expectedActivityVersion,
          connectionRef: prepareCredential.connectionRef,
          metadata: {
            source,
            actorId: input.actorId ?? null,
            credentialSource: prepareCredential.source,
            ...(input.metadata ?? {}),
          } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const raced = await prisma.outboundDispatch.findUnique({
        where: {
          organisationId_idempotencyKey: {
            organisationId: input.organisationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (raced?.externalOutcome === MessagingExternalOutcome.CONFIRMED) {
        return { ok: true as const, code: "ALREADY_CONFIRMED" as const, dispatch: raced };
      }
      return {
        ok: false as const,
        code: "IDEMPOTENT_RACE",
        dispatch: raced,
      };
    }
  }
  if (!dispatch) throw new Error("Outbound dispatch was not prepared");
  const dispatchId = dispatch.id;

  if (source === "HUMAN") {
    // Invalidate competing automated prepared work for this conversation.
    await prisma.outboundDispatch.updateMany({
      where: {
        organisationId: input.organisationId,
        conversationId: input.conversationId,
        id: { not: dispatchId },
        externalOutcome: {
          in: [
            MessagingExternalOutcome.NOT_STARTED,
            MessagingExternalOutcome.PREPARED,
          ],
        },
        NOT: { holder: { startsWith: "human:" } },
      },
      data: {
        externalOutcome: MessagingExternalOutcome.FAILED,
        failureCode: "STALE_CONTEXT",
        staleCancelled: true,
        metadata: { reason: "human_intervention" },
      },
    });
  }

  const leased = await acquireLease({
    organisationId: input.organisationId,
    conversationId: input.conversationId,
    holder,
    preempt: source === "HUMAN",
    expectedLastMessageId,
    expectedActivityVersion,
  });
  if (!leased) {
    return { ok: false as const, code: "LEASE_UNAVAILABLE" as const, dispatch };
  }

  try {
    // Automated sources: human/customer activity must cancel stale AI work.
    // HUMAN: do not fail on mid-flight version drift (authoritative send);
    // idempotency + optional client expectedActivityVersion cover replay.
    if (source !== "HUMAN") {
      const current = await prisma.conversation.findFirst({
        where: {
          id: input.conversationId,
          organisationId: input.organisationId,
          contactId: input.contactId,
          deletedAt: null,
        },
        select: { activityVersion: true },
      });
      if (!current || current.activityVersion !== expectedActivityVersion) {
        const stale = await markDispatchFailed({
          dispatchId,
          organisationId: input.organisationId,
          conversationId: input.conversationId,
          outcome: MessagingExternalOutcome.FAILED,
          failureCode: "STALE_CONTEXT",
        });
        return { ok: false as const, code: "STALE_CONTEXT" as const, dispatch: stale };
      }
    }

    // Gate #2 — dispatch-time contactability (opt-out/suppression/closed after PREPARED)
    try {
      await assertContactable({
        organisationId: input.organisationId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        channel,
        actionType,
      });
    } catch (error) {
      if (error instanceof ContactabilityError) {
        const failed = await markDispatchFailed({
          dispatchId,
          organisationId: input.organisationId,
          conversationId: input.conversationId,
          outcome: MessagingExternalOutcome.FAILED,
          failureCode: error.code,
          emitFailedEvent: true,
        });
        return { ok: false as const, code: error.code, dispatch: failed };
      }
      throw error;
    }

    const preparedConnectionRef =
      typeof dispatch.connectionRef === "string" ? dispatch.connectionRef : null;
    const credential = await resolveMessagingSendCredential(input.organisationId, {
      preparedConnectionRef: preparedConnectionRef ?? undefined,
      provider,
    });

    if (credential.source === "revoked") {
      const failed = await markDispatchFailed({
        dispatchId,
        organisationId: input.organisationId,
        conversationId: input.conversationId,
        outcome: MessagingExternalOutcome.FAILED,
        failureCode: "CONNECTION_REVOKED",
        emitFailedEvent: true,
      });
      return { ok: false as const, code: "CONNECTION_REVOKED" as const, dispatch: failed };
    }
    // Missing token: still call the adapter. Test/dev may mock; production adapter fails closed.
    // Do not invent credentials. CONNECTION_REVOKED above already blocks deactivated org tokens.

    dispatch = await prisma.outboundDispatch.update({
      where: { id: dispatchId },
      data: {
        externalOutcome: MessagingExternalOutcome.DISPATCHING,
        dispatchedAt: new Date(),
        attemptCount: { increment: 1 },
        connectionRef: credential.connectionRef,
      },
    });

    const adapter = await getMessagingAdapterForOrganisation(
      input.organisationId,
      true,
      provider,
    );
    let result;
    try {
      result = await adapter.sendMessage({
        organisationId: input.organisationId,
        contactExternalId: input.contactExternalId,
        text,
        threadId: input.threadId,
        apiToken: credential.token ?? undefined,
        metadata: { dispatchId, source },
      });
    } catch (error) {
      // Transport threw after possible provider accept — do not retry blindly.
      const failed = await markDispatchFailed({
        dispatchId,
        organisationId: input.organisationId,
        conversationId: input.conversationId,
        outcome: MessagingExternalOutcome.RECONCILIATION_REQUIRED,
        failureCode: "DELIVERY_UNCERTAIN",
        providerError: error instanceof Error ? error.message : "send threw",
        emitFailedEvent: true,
      });
      return { ok: false as const, code: "RECONCILIATION_REQUIRED" as const, dispatch: failed };
    }

    if (!result.ok) {
      const outcome = result.deliveryUncertain
        ? MessagingExternalOutcome.RECONCILIATION_REQUIRED
        : MessagingExternalOutcome.FAILED;
      const failed = await markDispatchFailed({
        dispatchId,
        organisationId: input.organisationId,
        conversationId: input.conversationId,
        outcome,
        failureCode: result.deliveryUncertain
          ? "DELIVERY_UNCERTAIN"
          : "PROVIDER_SEND_FAILED",
        providerError: result.error,
        metadata: { providerResponse: result.raw ?? null } as Prisma.InputJsonValue,
        emitFailedEvent: true,
      });
      return { ok: false as const, code: outcome, dispatch: failed };
    }

    const confirmedAt = new Date();
    const confirmed = await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          organisationId: input.organisationId,
          conversationId: input.conversationId,
          externalId: result.externalMessageId,
          direction: MessageDirection.OUTBOUND,
          senderType: sourceToSenderType(source),
          body: text,
          origin: result.provider || provider,
          deliveryStatus: "SENT",
          inReplyToMessageId: expectedLastMessageId,
          agentVersion: input.agentVersion,
          rawPayload: result.raw as Prisma.InputJsonValue | undefined,
        },
      });
      await tx.conversation.update({
        where: { id: input.conversationId },
        data: {
          activityVersion: { increment: 1 },
          lastMessageAt: confirmedAt,
          lastOutboundAt: confirmedAt,
          lastMessagePreview: text.slice(0, 140),
          ...(source === "HUMAN"
            ? {
                aiPaused: true,
                handlingMode: HandlingMode.HUMAN,
              }
            : {}),
        },
      });
      const dispatchRow = await tx.outboundDispatch.update({
        where: { id: dispatchId },
        data: {
          externalOutcome: MessagingExternalOutcome.CONFIRMED,
          externalMessageId: result.externalMessageId,
          messageId: message.id,
          confirmedAt,
          failureCode: null,
          providerError: null,
          metadata: {
            source,
            actorId: input.actorId ?? null,
            providerResponse: result.raw ?? null,
            ...(result.externalMessageId
              ? {}
              : { note: "Provider confirmed send without an external message id" }),
          } as Prisma.InputJsonValue,
        },
      });
      // MESSAGE_SENT only after provider confirmation.
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "MESSAGE_SENT",
        aggregateType: "Message",
        aggregateId: message.id,
        payload: {
          messageId: message.id,
          conversationId: input.conversationId,
          provider: result.provider || provider,
        },
        actorType: source === "HUMAN" ? "USER" : "SYSTEM",
        actorId: input.actorId,
        dedupeKey: `MESSAGE_SENT:${message.id}`,
      });
      return dispatchRow;
    });
    return { ok: true as const, code: "CONFIRMED" as const, dispatch: confirmed };
  } finally {
    await releaseLease(input.conversationId, holder);
  }
}

/** @deprecated Prefer dispatchOutboundMessage — kept for call-site compatibility. */
export async function prepareAndSendOutbound(input: {
  organisationId: string;
  conversationId: string;
  contactId: string;
  contactExternalId: string;
  text: string;
  holder: string;
  idempotencyKey: string;
  provider?: string;
  channel?: string;
  threadId?: string;
  agentVersion?: string;
  source?: OutboundSource;
  actorId?: string;
}) {
  const source: OutboundSource =
    input.source ??
    (input.holder.startsWith("human:")
      ? "HUMAN"
      : input.holder.startsWith("followup:")
        ? "FOLLOW_UP"
        : input.holder.startsWith("automation:")
          ? "AUTOMATION"
          : input.holder.startsWith("mission:")
            ? "MISSION"
            : "AI");

  return dispatchOutboundMessage({
    organisationId: input.organisationId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    contactExternalId: input.contactExternalId,
    content: input.text,
    source,
    idempotencyKey: input.idempotencyKey,
    holder: input.holder,
    provider: input.provider,
    channel: input.channel ?? input.provider,
    threadId: input.threadId,
    agentVersion: input.agentVersion,
    actorId: input.actorId,
  });
}
