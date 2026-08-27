import { FollowUpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { evaluateMessagingWindow } from "@/lib/messaging-window";
import { writeAuditLog } from "@/services/audit";
import { recordFailedJob } from "@/services/failed-jobs";
import { assertContactable } from "@/services/messaging/contactability";
import { prepareAndSendOutbound } from "@/services/messaging/outbound";
import { isContactSuppressed } from "@/services/messaging/suppression";

// Re-export enqueue from jobs layer (no-op — Postgres sweep is authoritative).
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

  for (const followUp of due) {
    if (
      !followUp.conversation ||
      followUp.conversation.aiPaused ||
      followUp.conversation.closedAt
    ) {
      await prisma.followUp.update({
        where: { id: followUp.id },
        data: {
          status: FollowUpStatus.CANCELLED,
          cancelReason: followUp.conversation?.closedAt
            ? "Conversation closed"
            : "AI paused or missing conversation",
        },
      });
      continue;
    }

    try {
      if (
        await isContactSuppressed(
          followUp.organisationId,
          followUp.contactId,
          "manychat",
        )
      ) {
        throw new Error("Contact is actively suppressed");
      }
      await assertContactable({
        organisationId: followUp.organisationId,
        contactId: followUp.contactId,
        conversationId: followUp.conversationId ?? undefined,
        channel: "manychat",
        actionType: "FOLLOW_UP",
      });
    } catch (error) {
      await prisma.followUp.update({
        where: { id: followUp.id },
        data: {
          status: FollowUpStatus.CANCELLED,
          cancelReason:
            error instanceof Error ? error.message : "Contact is not contactable",
        },
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

    const sendResult = await prepareAndSendOutbound({
      organisationId: followUp.organisationId,
      conversationId: followUp.conversationId!,
      contactId: followUp.contactId,
      contactExternalId: externalId,
      text: body,
      source: "FOLLOW_UP",
      holder: `followup:${followUp.id}`,
      idempotencyKey: `followup:${followUp.id}`,
      threadId: followUp.conversation.externalThreadId ?? undefined,
    });

    if (!sendResult.ok) {
      if (sendResult.code === "STALE_CONTEXT") {
        await prisma.followUp.update({
          where: { id: followUp.id },
          data: {
            status: FollowUpStatus.CANCELLED,
            cancelReason: "STALE_CONTEXT",
          },
        });
        continue;
      }

      await prisma.followUp.update({
        where: { id: followUp.id },
        data: { status: FollowUpStatus.FAILED },
      });
      await recordFailedJob({
        organisationId: followUp.organisationId,
        queue: "follow-ups",
        jobName: "send-followup",
        payload: { followUpId: followUp.id },
        error:
          typeof sendResult.code === "string"
            ? sendResult.code
            : "Outbound send failed",
      });
      continue;
    }

    const outboundAt = new Date();
    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { status: FollowUpStatus.SENT, sentAt: outboundAt },
    });

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
