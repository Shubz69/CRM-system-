import { NextRequest } from "next/server";
import { z } from "zod";
import { HandlingMode, MessageDirection, MessageSenderType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";
import { getMessagingAdapter } from "@/adapters/messaging";
import { cancelPendingFollowUps } from "@/services/followups";
import { writeAuditLog } from "@/services/audit";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("inbox:read");
    const { id } = await params;

    const conversation = await prisma.conversation.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      include: {
        contact: {
          include: {
            tags: { include: { tag: true } },
            notes: { orderBy: { createdAt: "desc" }, take: 20 },
          },
        },
        messages: { orderBy: { sentAt: "asc" } },
        leads: {
          where: { deletedAt: null },
          include: {
            stage: true,
            answers: { include: { field: true } },
            scores: {
              orderBy: { calculatedAt: "desc" },
              take: 1,
              include: { components: true },
            },
            bookings: { orderBy: { createdAt: "desc" } },
          },
        },
        objections: { orderBy: { detectedAt: "desc" }, take: 20 },
        questions: { orderBy: { detectedAt: "desc" }, take: 20 },
        buyingSignals: { orderBy: { detectedAt: "desc" }, take: 20 },
        assignments: {
          where: { active: true },
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        followUps: { orderBy: { scheduledFor: "asc" }, take: 10 },
      },
    });

    if (!conversation) return jsonError("Conversation not found", 404);

    await prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });

    return Response.json({ conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

const patchSchema = z.object({
  aiPaused: z.boolean().optional(),
  handlingMode: z.nativeEnum(HandlingMode).optional(),
  assignUserId: z.string().nullable().optional(),
  note: z.string().optional(),
  qualificationStatus: z.enum(["UNKNOWN", "QUALIFYING", "QUALIFIED", "DISQUALIFIED"]).optional(),
  stageId: z.string().optional(),
  reply: z.string().min(1).optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("inbox:write");
    const { id } = await params;
    const body = patchSchema.parse(await req.json());

    const conversation = await prisma.conversation.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      include: {
        contact: { include: { identifiers: true } },
        leads: { where: { deletedAt: null }, take: 1 },
      },
    });
    if (!conversation) return jsonError("Conversation not found", 404);

    if (body.aiPaused !== undefined || body.handlingMode) {
      await prisma.conversation.update({
        where: { id },
        data: {
          aiPaused: body.aiPaused,
          handlingMode:
            body.handlingMode ??
            (body.aiPaused === true
              ? HandlingMode.PAUSED
              : body.aiPaused === false
                ? HandlingMode.AI
                : undefined),
          needsHumanReview: body.aiPaused === true ? true : undefined,
        },
      });
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: body.aiPaused ? "conversation.ai_paused" : "conversation.ai_resumed",
        entityType: "Conversation",
        entityId: id,
      });
    }

    if (body.assignUserId !== undefined) {
      await prisma.conversationAssignment.updateMany({
        where: { conversationId: id, active: true },
        data: { active: false },
      });
      if (body.assignUserId) {
        await prisma.conversationAssignment.create({
          data: {
            conversationId: id,
            userId: body.assignUserId,
            active: true,
          },
        });
      }
    }

    if (body.note) {
      await prisma.note.create({
        data: {
          organisationId: session.organisationId,
          conversationId: id,
          contactId: conversation.contactId,
          authorId: session.userId,
          body: body.note,
        },
      });
    }

    const lead = conversation.leads[0];
    if (lead && (body.qualificationStatus || body.stageId)) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          qualificationStatus: body.qualificationStatus,
          stageId: body.stageId,
        },
      });
    }

    if (body.reply) {
      const identifier = conversation.contact.identifiers.find((i) => i.channel === "manychat");
      const adapter = getMessagingAdapter(false);
      const sendResult = await adapter.sendMessage({
        organisationId: session.organisationId,
        contactExternalId: identifier?.identifier.replace(/^manychat:/, "") || conversation.contactId,
        text: body.reply,
        threadId: conversation.externalThreadId ?? undefined,
      });

      await prisma.message.create({
        data: {
          conversationId: id,
          organisationId: session.organisationId,
          externalId: sendResult.externalMessageId,
          direction: MessageDirection.OUTBOUND,
          senderType: MessageSenderType.HUMAN,
          body: body.reply,
          deliveryStatus: sendResult.ok ? "sent" : "failed",
        },
      });

      await prisma.conversation.update({
        where: { id },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: body.reply.slice(0, 140),
          aiPaused: true,
          handlingMode: HandlingMode.HUMAN,
        },
      });

      await cancelPendingFollowUps({
        conversationId: id,
        reason: "Human replied",
      });
    }

    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    logger.error("Conversation patch failed", { message });
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
