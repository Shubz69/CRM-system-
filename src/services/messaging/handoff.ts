import {
  FollowUpStatus,
  HandlingMode,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db";

export async function buildHandoffPacket(input: {
  conversationId: string;
  organisationId: string;
  reason: string;
  understanding?: unknown;
  nba?: unknown;
}) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: input.conversationId,
      organisationId: input.organisationId,
      deletedAt: null,
    },
    select: {
      id: true,
      contactId: true,
      subject: true,
      summary: true,
      intent: true,
      sentiment: true,
      priorityClass: true,
      activityVersion: true,
      messages: {
        orderBy: { sentAt: "desc" },
        take: 3,
        select: {
          id: true,
          direction: true,
          senderType: true,
          body: true,
          sentAt: true,
        },
      },
    },
  });
  if (!conversation) throw new Error("Conversation not found");

  return {
    version: 1,
    reason: input.reason,
    generatedAt: new Date().toISOString(),
    conversation: {
      id: conversation.id,
      contactId: conversation.contactId,
      subject: conversation.subject,
      summary: conversation.summary,
      intent: conversation.intent,
      sentiment: conversation.sentiment,
      priorityClass: conversation.priorityClass,
      activityVersion: conversation.activityVersion,
    },
    recentMessages: [...conversation.messages].reverse(),
    understanding: input.understanding ?? null,
    nextBestAction: input.nba ?? null,
  };
}

export async function applyHumanHandoff(input: {
  conversationId: string;
  organisationId: string;
  reason: string;
  understanding?: unknown;
  nba?: unknown;
}) {
  const packet = await buildHandoffPacket(input);
  const [, cancelled] = await prisma.$transaction([
    prisma.conversation.updateMany({
      where: {
        id: input.conversationId,
        organisationId: input.organisationId,
        deletedAt: null,
      },
      data: {
        handlingMode: HandlingMode.HUMAN,
        aiPaused: true,
        needsHumanReview: true,
        handoffReason: input.reason,
        handoffPacket: packet as unknown as Prisma.InputJsonValue,
        activityVersion: { increment: 1 },
      },
    }),
    prisma.followUp.updateMany({
      where: {
        organisationId: input.organisationId,
        conversationId: input.conversationId,
        status: FollowUpStatus.SCHEDULED,
      },
      data: {
        status: FollowUpStatus.CANCELLED,
        cancelReason: `Human handoff: ${input.reason}`,
      },
    }),
  ]);
  return { packet, cancelledFollowUps: cancelled.count };
}
