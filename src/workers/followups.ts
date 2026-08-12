import { Worker } from "bullmq";
import { FollowUpStatus, MessageDirection, MessageSenderType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { evaluateMessagingWindow } from "@/lib/messaging-window";
import { getMessagingAdapter } from "@/adapters/messaging";
import { writeAuditLog } from "@/services/audit";
import { recordFailedJob } from "@/services/failed-jobs";
import { getRedisConnection } from "@/jobs/redis";
import { QUEUE_FOLLOW_UPS } from "@/jobs/queues";

// Re-export enqueue from jobs layer (Next.js enqueues only).
export { enqueueFollowUpCheck } from "@/jobs/follow-ups";
export { getFollowUpQueue } from "@/jobs/queues";

export async function processDueFollowUps(): Promise<number> {
  const due = await prisma.followUp.findMany({
    where: {
      status: FollowUpStatus.SCHEDULED,
      scheduledFor: { lte: new Date() },
      contact: { optedOut: false },
    },
    include: {
      contact: { include: { identifiers: true } },
      conversation: true,
    },
    take: 50,
  });

  let sent = 0;
  const adapter = getMessagingAdapter(false);

  for (const followUp of due) {
    if (!followUp.conversation || followUp.conversation.aiPaused) {
      await prisma.followUp.update({
        where: { id: followUp.id },
        data: { status: FollowUpStatus.CANCELLED, cancelReason: "AI paused or missing conversation" },
      });
      continue;
    }

    const windowState = evaluateMessagingWindow({
      lastInboundAt: followUp.conversation.lastInboundAt,
      messagingWindowExpiresAt: followUp.conversation.messagingWindowExpiresAt,
      humanMessagingWindowExpiresAt: followUp.conversation.humanMessagingWindowExpiresAt,
      aiPaused: followUp.conversation.aiPaused,
      handlingMode: followUp.conversation.handlingMode,
      optedOut: followUp.contact.optedOut,
    });

    if (!windowState.automatedReplyAllowed) {
      await prisma.followUp.update({
        where: { id: followUp.id },
        data: {
          status: FollowUpStatus.CANCELLED,
          cancelReason: windowState.automatedBlockedReason || "Messaging window closed",
        },
      });
      await writeAuditLog({
        organisationId: followUp.organisationId,
        action: "followup.blocked_messaging_window",
        entityType: "FollowUp",
        entityId: followUp.id,
        metadata: { reason: windowState.automatedBlockedReason },
      });
      continue;
    }

    const identifier = followUp.contact.identifiers.find((i) => i.channel === "manychat");
    const externalId = identifier?.identifier.replace(/^manychat:/, "") || followUp.contactId;
    const body =
      followUp.messageBody ||
      "Just checking in — happy to answer any questions or share a booking link when you are ready.";

    const result = await adapter.sendMessage({
      organisationId: followUp.organisationId,
      contactExternalId: externalId,
      text: body,
      threadId: followUp.conversation.externalThreadId ?? undefined,
    });

    if (!result.ok) {
      await prisma.followUp.update({
        where: { id: followUp.id },
        data: { status: FollowUpStatus.FAILED },
      });
      await recordFailedJob({
        organisationId: followUp.organisationId,
        queue: "follow-ups",
        jobName: "send-followup",
        payload: { followUpId: followUp.id },
        error: result.error || "Outbound send failed",
      });
      continue;
    }

    const outboundAt = new Date();
    await prisma.$transaction([
      prisma.followUp.update({
        where: { id: followUp.id },
        data: { status: FollowUpStatus.SENT, sentAt: outboundAt },
      }),
      prisma.message.create({
        data: {
          conversationId: followUp.conversationId!,
          organisationId: followUp.organisationId,
          externalId: result.externalMessageId,
          direction: MessageDirection.OUTBOUND,
          senderType: MessageSenderType.SYSTEM,
          body,
          deliveryStatus: "sent",
        },
      }),
      prisma.conversation.update({
        where: { id: followUp.conversationId! },
        data: {
          lastMessageAt: outboundAt,
          lastMessagePreview: body.slice(0, 140),
          lastOutboundAt: outboundAt,
        },
      }),
    ]);

    await writeAuditLog({
      organisationId: followUp.organisationId,
      action: "followup.sent",
      entityType: "FollowUp",
      entityId: followUp.id,
    });

    sent += 1;
  }

  return sent;
}

/** In-process fallback when Redis is unavailable (local/dev ONLY). */
export function startInProcessFollowUpLoop(intervalMs = 60_000) {
  logger.error(
    "⚠️  IN-PROCESS FOLLOW-UP LOOP STARTED — Redis unavailable. " +
      "Local development only. agent-runs will not execute.",
  );
  const timer = setInterval(() => {
    processDueFollowUps()
      .then((sent) => {
        if (sent > 0) logger.info("In-process follow-ups sent", { sent });
      })
      .catch((error) =>
        logger.error("In-process follow-up loop failed", {
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
  }, intervalMs);
  return timer;
}

/** @deprecated Prefer the unified worker entry (src/workers/index.ts). */
export function startBullWorker() {
  const worker = new Worker(
    QUEUE_FOLLOW_UPS,
    async () => {
      const sent = await processDueFollowUps();
      return { sent };
    },
    { connection: getRedisConnection() },
  );

  worker.on("failed", (job, err) => {
    logger.error("Follow-up worker failed", {
      jobId: job?.id,
      message: err.message,
    });
    void recordFailedJob({
      queue: "follow-ups",
      jobName: job?.name || "process-due-followups",
      payload: { jobId: job?.id },
      error: err.message,
      attempts: job?.attemptsMade,
    });
  });

  return worker;
}
