/**
 * Zernio webhook business-event coverage — tenant-scoped, idempotent, no invented IDs.
 * Messaging lifecycle + social engagement + Content OS publish confirmation.
 */

import { Prisma, PublishingJobStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { appendDomainEvent } from "@/services/domain-events/append";
import { recordPublishResult } from "@/services/content-os";

export const ZERNIO_SUPPORTED_WEBHOOK_EVENTS = [
  "account.connected",
  "account.disconnected",
  "message.received",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
  "message.edited",
  "message.deleted",
  "conversation.started",
  "reaction.received",
  "referral.received",
  "comment.received",
  "post.published",
  "post.failed",
  "post.partial",
  "post.platform.published",
  "post.platform.failed",
  "post.platform.deleted",
] as const;

export type ZernioSupportedWebhookEvent = (typeof ZERNIO_SUPPORTED_WEBHOOK_EVENTS)[number];

export type ZernioCoverageResult = {
  handled: boolean;
  ignored?: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function mergeJson(
  existing: unknown,
  patch: Record<string, unknown>,
): Prisma.InputJsonValue {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return { ...base, ...patch } as Prisma.InputJsonValue;
}

function extractMessageExternalId(payload: Record<string, unknown>): string | undefined {
  const message = asRecord(payload.message) || {};
  return pickString(
    message.platformMessageId,
    message.id,
    message.messageId,
    payload.platformMessageId,
    payload.messageId,
  );
}

function extractMessageText(payload: Record<string, unknown>): string | undefined {
  const message = asRecord(payload.message) || {};
  return pickString(message.text, message.body, message.content, payload.text);
}

async function findTenantMessage(organisationId: string, externalId: string) {
  return prisma.message.findFirst({
    where: { organisationId, externalId },
    select: {
      id: true,
      conversationId: true,
      organisationId: true,
      body: true,
      rawPayload: true,
      deliveryStatus: true,
      deliveredAt: true,
      readAt: true,
    },
  });
}

async function emitStateChanged(input: {
  organisationId: string;
  entityType: string;
  entityId: string;
  dimension: string;
  fromValue?: string;
  toValue: string;
  dedupeKey: string;
}) {
  await prisma.$transaction(async (tx) => {
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "STATE_CHANGED",
      aggregateType: input.entityType,
      aggregateId: input.entityId,
      payload: {
        organisationId: input.organisationId,
        entityType: input.entityType,
        entityId: input.entityId,
        dimension: input.dimension,
        fromValue: input.fromValue,
        toValue: input.toValue,
      },
      dedupeKey: input.dedupeKey,
    });
  });
}

async function handleMessagingLifecycle(input: {
  organisationId: string;
  eventType: string;
  eventId: string;
  payload: Record<string, unknown>;
}): Promise<ZernioCoverageResult> {
  const externalId = extractMessageExternalId(input.payload);
  if (!externalId) {
    return { handled: true, ignored: true, reason: "missing_message_external_id" };
  }

  const message = await findTenantMessage(input.organisationId, externalId);
  if (!message) {
    return {
      handled: true,
      ignored: true,
      reason: "message_not_found_for_tenant",
      detail: { externalId },
    };
  }

  const now = new Date();
  const text = extractMessageText(input.payload);

  if (input.eventType === "message.sent") {
    await prisma.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: "SENT",
        rawPayload: mergeJson(message.rawPayload, {
          zernioLifecycle: { event: "message.sent", at: now.toISOString(), eventId: input.eventId },
        }),
      },
    });
    await prisma.$transaction(async (tx) => {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "MESSAGE_SENT",
        aggregateType: "Message",
        aggregateId: message.id,
        payload: {
          organisationId: input.organisationId,
          messageId: message.id,
          conversationId: message.conversationId,
          provider: "ZERNIO",
        },
        dedupeKey: `zernio:msg_sent:${input.organisationId}:${input.eventId}`,
      });
    });
    return { handled: true, detail: { messageId: message.id, status: "SENT" } };
  }

  if (input.eventType === "message.delivered") {
    await prisma.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: "DELIVERED",
        deliveredAt: message.deliveredAt ?? now,
        rawPayload: mergeJson(message.rawPayload, {
          zernioLifecycle: {
            event: "message.delivered",
            at: now.toISOString(),
            eventId: input.eventId,
          },
        }),
      },
    });
    return { handled: true, detail: { messageId: message.id, status: "DELIVERED" } };
  }

  if (input.eventType === "message.read") {
    await prisma.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: "READ",
        readAt: message.readAt ?? now,
        deliveredAt: message.deliveredAt ?? now,
        rawPayload: mergeJson(message.rawPayload, {
          zernioLifecycle: { event: "message.read", at: now.toISOString(), eventId: input.eventId },
        }),
      },
    });
    return { handled: true, detail: { messageId: message.id, status: "READ" } };
  }

  if (input.eventType === "message.failed") {
    const err =
      pickString(
        asRecord(input.payload.message)?.error,
        input.payload.error,
        input.payload.failureCode,
      ) || "provider_failed";
    await prisma.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: "FAILED",
        failureCode: "ZERNIO_MESSAGE_FAILED",
        providerError: err.slice(0, 2000),
        rawPayload: mergeJson(message.rawPayload, {
          zernioLifecycle: {
            event: "message.failed",
            at: now.toISOString(),
            eventId: input.eventId,
            error: err,
          },
        }),
      },
    });
    await prisma.$transaction(async (tx) => {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "MESSAGE_FAILED",
        aggregateType: "Message",
        aggregateId: message.id,
        payload: {
          organisationId: input.organisationId,
          conversationId: message.conversationId,
          failureCode: "ZERNIO_MESSAGE_FAILED",
        },
        dedupeKey: `zernio:msg_failed:${input.organisationId}:${input.eventId}`,
      });
    });
    return { handled: true, detail: { messageId: message.id, status: "FAILED" } };
  }

  if (input.eventType === "message.edited") {
    if (!text) {
      return { handled: true, ignored: true, reason: "edited_without_text" };
    }
    await prisma.message.update({
      where: { id: message.id },
      data: {
        body: text,
        rawPayload: mergeJson(message.rawPayload, {
          zernioLifecycle: {
            event: "message.edited",
            at: now.toISOString(),
            eventId: input.eventId,
            previousBodyPreview: message.body.slice(0, 200),
          },
        }),
      },
    });
    await emitStateChanged({
      organisationId: input.organisationId,
      entityType: "Message",
      entityId: message.id,
      dimension: "body",
      toValue: "edited",
      dedupeKey: `zernio:msg_edited:${input.organisationId}:${input.eventId}`,
    });
    return { handled: true, detail: { messageId: message.id, status: "EDITED" } };
  }

  if (input.eventType === "message.deleted") {
    // Soft state only — Message has no deletedAt; preserve body + audit in rawPayload.
    await prisma.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: "DELETED",
        rawPayload: mergeJson(message.rawPayload, {
          zernioLifecycle: {
            event: "message.deleted",
            at: now.toISOString(),
            eventId: input.eventId,
            softDeleted: true,
            preservedBody: message.body,
          },
        }),
      },
    });
    await emitStateChanged({
      organisationId: input.organisationId,
      entityType: "Message",
      entityId: message.id,
      dimension: "deliveryStatus",
      fromValue: message.deliveryStatus || undefined,
      toValue: "DELETED",
      dedupeKey: `zernio:msg_deleted:${input.organisationId}:${input.eventId}`,
    });
    return { handled: true, detail: { messageId: message.id, status: "DELETED" } };
  }

  return { handled: false };
}

async function handleConversationStarted(input: {
  organisationId: string;
  eventId: string;
  payload: Record<string, unknown>;
}): Promise<ZernioCoverageResult> {
  const conversation = asRecord(input.payload.conversation) || {};
  const threadId = pickString(
    conversation.id,
    conversation.conversationId,
    input.payload.conversationId,
  );
  const account = asRecord(input.payload.account) || {};
  const accountId = pickString(account.id, input.payload.accountId);

  let conversationRow = null as { id: string; contactId: string | null } | null;
  if (threadId) {
    conversationRow = await prisma.conversation.findFirst({
      where: {
        organisationId: input.organisationId,
        OR: [
          { externalThreadId: threadId },
          { externalThreadId: `zernio:${accountId || "acct"}:${threadId}` },
        ],
      },
      select: { id: true, contactId: true },
    });
  }

  if (conversationRow) {
    await prisma.$transaction(async (tx) => {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "CONVERSATION_STATE_CHANGED",
        aggregateType: "Conversation",
        aggregateId: conversationRow!.id,
        payload: {
          organisationId: input.organisationId,
          conversationId: conversationRow!.id,
          field: "zernio.conversation.started",
          value: { threadId, accountId, eventId: input.eventId },
        },
        dedupeKey: `zernio:conv_started:${input.organisationId}:${input.eventId}`,
      });
    });
    return { handled: true, detail: { conversationId: conversationRow.id } };
  }

  // No local conversation yet — durable provenance only (do not invent CRM thread).
  await emitStateChanged({
    organisationId: input.organisationId,
    entityType: "ZernioConversation",
    entityId: threadId || input.eventId,
    dimension: "conversation.started",
    toValue: "started",
    dedupeKey: `zernio:conv_started:${input.organisationId}:${input.eventId}`,
  });
  return {
    handled: true,
    ignored: !threadId,
    reason: threadId ? "conversation_not_linked_yet" : "missing_thread_id",
    detail: { threadId },
  };
}

async function handleEngagement(input: {
  organisationId: string;
  eventType: "reaction.received" | "referral.received" | "comment.received";
  eventId: string;
  payload: Record<string, unknown>;
}): Promise<ZernioCoverageResult> {
  const account = asRecord(input.payload.account) || {};
  const comment = asRecord(input.payload.comment) || asRecord(input.payload.message) || {};
  const post = asRecord(input.payload.post) || asRecord(input.payload.media) || {};
  const author =
    asRecord(comment.author) ||
    asRecord(input.payload.author) ||
    asRecord(input.payload.from) ||
    {};
  const reaction = asRecord(input.payload.reaction) || {};
  const referral = asRecord(input.payload.referral) || asRecord(input.payload.source) || {};

  const network = pickString(account.platform, input.payload.platform, post.platform) || "unknown";
  const accountId = pickString(account.id, input.payload.accountId);
  const externalPostId = pickString(post.id, post.platformPostId, post.externalId, input.payload.postId);
  const externalCommentId = pickString(
    comment.id,
    comment.platformCommentId,
    comment.externalId,
    input.payload.commentId,
  );
  const authorExternalId = pickString(author.id, author.externalId, author.platformId, author.userId);
  const text = pickString(comment.text, comment.body, comment.content, input.payload.text);
  const timestamp = pickString(
    comment.createdAt,
    comment.timestamp,
    input.payload.timestamp,
    input.payload.createdAt,
  );

  const kind =
    input.eventType === "comment.received"
      ? "comment"
      : input.eventType === "reaction.received"
        ? "reaction"
        : "referral";

  // Never auto-DM commenters — engagement facts + DomainEvent only.
  await prisma.socialMetricFact.create({
    data: {
      organisationId: input.organisationId,
      platform: network,
      externalPostId: externalPostId || null,
      metric: kind === "comment" ? "comment_received" : kind === "reaction" ? "reaction_received" : "referral_received",
      value: null,
      source: "zernio",
      retrievedAt: timestamp ? new Date(timestamp) : new Date(),
      metadata: {
        provider: "ZERNIO",
        eventType: input.eventType,
        eventId: input.eventId,
        accountId,
        externalCommentId,
        authorExternalId,
        authorUsername: pickString(author.username, author.handle),
        text: text || null,
        reactionType: pickString(reaction.type, reaction.emoji, input.payload.reactionType),
        referral: Object.keys(referral).length ? referral : null,
        // Provenance only — do not invent CRM lead fields
      } as Prisma.InputJsonValue,
    },
  });

  // Attach reaction onto message activity when a provider message ID is present.
  if (kind === "reaction") {
    const messageExternalId = extractMessageExternalId(input.payload);
    if (messageExternalId) {
      const message = await findTenantMessage(input.organisationId, messageExternalId);
      if (message) {
        await prisma.message.update({
          where: { id: message.id },
          data: {
            rawPayload: mergeJson(message.rawPayload, {
              zernioReaction: {
                eventId: input.eventId,
                type: pickString(reaction.type, reaction.emoji, input.payload.reactionType),
                authorExternalId,
                at: new Date().toISOString(),
              },
            }),
          },
        });
        await prisma.$transaction(async (tx) => {
          await appendDomainEvent(tx, {
            organisationId: input.organisationId,
            eventType: "CONVERSATION_STATE_CHANGED",
            aggregateType: "Conversation",
            aggregateId: message.conversationId,
            payload: {
              organisationId: input.organisationId,
              conversationId: message.conversationId,
              field: "zernio.reaction",
              value: {
                messageId: message.id,
                reactionType: pickString(reaction.type, reaction.emoji),
                authorExternalId,
              },
            },
            dedupeKey: `zernio:reaction:${input.organisationId}:${input.eventId}`,
          });
        });
        return {
          handled: true,
          detail: { kind, messageId: message.id, conversationId: message.conversationId },
        };
      }
    }
  }

  const entityId =
    externalCommentId ||
    pickString(referral.ref, referral.id, input.payload.id) ||
    input.eventId;

  await emitStateChanged({
    organisationId: input.organisationId,
    entityType: "SocialEngagement",
    entityId,
    dimension: `zernio.${kind}`,
    toValue: kind,
    dedupeKey: `zernio:${kind}:${input.organisationId}:${input.eventId}`,
  });

  return {
    handled: true,
    detail: {
      kind,
      network,
      accountId,
      externalPostId,
      externalCommentId,
      authorExternalId,
      hasText: Boolean(text),
    },
  };
}

async function findPublishingJob(organisationId: string, payload: Record<string, unknown>) {
  const post = asRecord(payload.post) || asRecord(payload.data) || {};
  const platform = asRecord(payload.platform) || {};
  const meta = asRecord(payload.metadata) || asRecord(post.metadata) || {};

  const publishingJobId = pickString(
    meta.publishingJobId,
    meta.agentDeskJobId,
    payload.publishingJobId,
    post.publishingJobId,
  );
  if (publishingJobId) {
    const byId = await prisma.publishingJob.findFirst({
      where: { id: publishingJobId, organisationId },
    });
    if (byId) return byId;
  }

  const platformPostId = pickString(
    platform.postId,
    platform.id,
    post.platformPostId,
    post.externalPostId,
    payload.platformPostId,
  );
  const providerPostId = pickString(post.id, post.postId, payload.postId, payload.id);

  if (platformPostId) {
    const byPlatform = await prisma.publishingJob.findFirst({
      where: { organisationId, externalPostId: platformPostId },
    });
    if (byPlatform) return byPlatform;
  }
  if (providerPostId) {
    const byProvider = await prisma.publishingJob.findFirst({
      where: { organisationId, externalPostId: providerPostId },
    });
    if (byProvider) return byProvider;
  }

  return null;
}

async function handlePublishEvent(input: {
  organisationId: string;
  eventType: string;
  eventId: string;
  payload: Record<string, unknown>;
}): Promise<ZernioCoverageResult> {
  const post = asRecord(input.payload.post) || asRecord(input.payload.data) || {};
  const platform = asRecord(input.payload.platform) || {};
  const platformPostId = pickString(
    platform.postId,
    platform.id,
    post.platformPostId,
    post.externalPostId,
    input.payload.platformPostId,
  );
  const providerPostId = pickString(post.id, post.postId, input.payload.postId);
  const platformUrl = pickString(platform.url, post.url, post.permalink, input.payload.url);
  const error =
    pickString(
      input.payload.error,
      post.error,
      platform.error,
      asRecord(input.payload.failure)?.message,
    ) || undefined;

  const job = await findPublishingJob(input.organisationId, input.payload);

  // Always persist diagnostic metric — never invent external IDs when absent.
  await prisma.socialMetricFact.create({
    data: {
      organisationId: input.organisationId,
      platform: pickString(platform.name, post.platform, input.payload.platform) || "unknown",
      externalPostId: platformPostId || providerPostId || null,
      metric: `zernio_${input.eventType.replace(/\./g, "_")}`,
      value: null,
      source: "zernio",
      metadata: {
        provider: "ZERNIO",
        eventType: input.eventType,
        eventId: input.eventId,
        providerPostId: providerPostId || null,
        platformPostId: platformPostId || null,
        platformUrl: platformUrl || null,
        publishingJobId: job?.id || null,
        error: error || null,
      } as Prisma.InputJsonValue,
    },
  });

  if (!job) {
    return {
      handled: true,
      ignored: true,
      reason: "publishing_job_not_matched",
      detail: {
        providerPostId: providerPostId || null,
        platformPostId: platformPostId || null,
        // Do not invent success without a Content OS job
      },
    };
  }

  if (
    input.eventType === "post.published" ||
    input.eventType === "post.platform.published"
  ) {
    if (!platformPostId && !platformUrl && !providerPostId) {
      await recordPublishResult({
        organisationId: input.organisationId,
        jobId: job.id,
        reconciliationRequired: true,
        reconciliationNote: `Zernio ${input.eventType} without platform/provider post id`,
      });
      return {
        handled: true,
        detail: { jobId: job.id, status: "RECONCILIATION_REQUIRED" },
      };
    }
    await recordPublishResult({
      organisationId: input.organisationId,
      jobId: job.id,
      externalPostId: platformPostId || providerPostId,
      externalUrl: platformUrl,
    });
    return { handled: true, detail: { jobId: job.id, status: "PUBLISHED" } };
  }

  if (input.eventType === "post.failed" || input.eventType === "post.platform.failed") {
    await recordPublishResult({
      organisationId: input.organisationId,
      jobId: job.id,
      error: error || `Zernio ${input.eventType}`,
    });
    return { handled: true, detail: { jobId: job.id, status: "FAILED" } };
  }

  if (input.eventType === "post.partial") {
    if (platformPostId || providerPostId || platformUrl) {
      await prisma.publishingJob.updateMany({
        where: { id: job.id, organisationId: input.organisationId },
        data: {
          ...(platformPostId || providerPostId
            ? { externalPostId: platformPostId || providerPostId }
            : {}),
          ...(platformUrl ? { externalUrl: platformUrl } : {}),
        },
      });
    }
    await recordPublishResult({
      organisationId: input.organisationId,
      jobId: job.id,
      reconciliationRequired: true,
      reconciliationNote: error || "Zernio post.partial — provider confirmation incomplete",
    });
    return { handled: true, detail: { jobId: job.id, status: "RECONCILIATION_REQUIRED" } };
  }

  if (input.eventType === "post.platform.deleted") {
    if (
      job.status === PublishingJobStatus.PUBLISHED ||
      job.externalPostId
    ) {
      await prisma.publishingJob.updateMany({
        where: {
          id: job.id,
          organisationId: input.organisationId,
        },
        data: {
          status: PublishingJobStatus.RECONCILIATION_REQUIRED,
          reconciliationNote: `Platform deleted post (${platformPostId || providerPostId || "unknown id"})`,
          error: error || "platform_deleted",
        },
      });
      await emitStateChanged({
        organisationId: input.organisationId,
        entityType: "PublishingJob",
        entityId: job.id,
        dimension: "platform_presence",
        fromValue: job.status,
        toValue: "platform_deleted",
        dedupeKey: `zernio:post_deleted:${input.organisationId}:${input.eventId}`,
      });
      return {
        handled: true,
        detail: { jobId: job.id, status: "RECONCILIATION_REQUIRED" },
      };
    }
    return {
      handled: true,
      ignored: true,
      reason: "delete_event_without_confirmed_publish",
      detail: { jobId: job.id },
    };
  }

  return { handled: false };
}

/**
 * Route non-inbound Zernio events into Agent Desk messaging / engagement / Content OS.
 * Returns handled:false for unknown types (caller should ack safely).
 */
export async function handleZernioCoverageEvent(input: {
  organisationId: string;
  zernioProfileId: string;
  eventType: string;
  eventId: string;
  payload: Record<string, unknown>;
  accountId?: string | null;
}): Promise<ZernioCoverageResult> {
  const { eventType } = input;

  if (
    eventType === "message.sent" ||
    eventType === "message.delivered" ||
    eventType === "message.read" ||
    eventType === "message.failed" ||
    eventType === "message.edited" ||
    eventType === "message.deleted"
  ) {
    return handleMessagingLifecycle(input);
  }

  if (eventType === "conversation.started") {
    return handleConversationStarted(input);
  }

  if (
    eventType === "reaction.received" ||
    eventType === "referral.received" ||
    eventType === "comment.received"
  ) {
    return handleEngagement({
      ...input,
      eventType,
    });
  }

  if (
    eventType === "post.published" ||
    eventType === "post.failed" ||
    eventType === "post.partial" ||
    eventType === "post.platform.published" ||
    eventType === "post.platform.failed" ||
    eventType === "post.platform.deleted"
  ) {
    return handlePublishEvent(input);
  }

  return { handled: false, reason: "unknown_event_type" };
}
