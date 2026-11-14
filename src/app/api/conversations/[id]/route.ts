import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { HandlingMode, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { roleHasPermission } from "@/lib/permissions";
import { requirePermission, requirePermissionForMutation, jsonError, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";
import { markHumanLeadChange } from "@/services/lead-stage-guard";
import { cancelPendingFollowUps } from "@/services/followups";
import { writeAuditLog } from "@/services/audit";
import { logger } from "@/lib/logger";
import { evaluateMessagingWindow } from "@/lib/messaging-window";
import { dispatchOutboundMessage } from "@/services/messaging/outbound";

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
            scoreEvents: { orderBy: { createdAt: "desc" }, take: 10 },
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

    // The open thread is polled — only write when there is something to clear.
    if (conversation.unreadCount > 0) {
      await prisma.conversation.updateMany({
        where: { id, organisationId: session.organisationId },
        data: { unreadCount: 0 },
      });
    }

    return Response.json({ conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

/**
 * Idempotency key for a manual inbox reply.
 * - Client keys (one per composed message) are scoped to this conversation + user so a
 *   reused/foreign key can never match another conversation's dispatch.
 * - Without a client key, fall back to a per-minute bucket: a double-submit still
 *   collapses, but sending the same text again later is a new message, not a silent no-op.
 */
function humanReplyIdempotencyKey(input: {
  conversationId: string;
  userId: string;
  reply: string;
  clientKey?: string;
  now?: number;
}): string {
  if (input.clientKey) {
    return `human-reply:${input.conversationId}:${input.userId}:client:${input.clientKey}`;
  }
  const bodyHash = createHash("sha256").update(input.reply).digest("hex").slice(0, 16);
  const minuteBucket = Math.floor((input.now ?? Date.now()) / 60_000);
  return `human-reply:${input.conversationId}:${input.userId}:${bodyHash}:${minuteBucket}`;
}

const patchSchema = z.object({
  aiPaused: z.boolean().optional(),
  handlingMode: z.nativeEnum(HandlingMode).optional(),
  assignUserId: z.string().nullable().optional(),
  note: z.string().optional(),
  qualificationStatus: z.enum(["UNKNOWN", "QUALIFYING", "QUALIFIED", "DISQUALIFIED"]).optional(),
  stageId: z.string().optional(),
  reply: z.string().min(1).optional(),
  /** Client idempotency key — survives double-click / browser retry. */
  replyIdempotencyKey: z.string().min(8).max(128).optional(),
  /** Optional activity version for replay protection (not mid-flight drift). */
  expectedActivityVersion: z.number().int().nonnegative().optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation(
      "inbox:write",
      req,
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null,
    );
    const { id } = await params;
    const body = patchSchema.parse(raw);

    // Reassigning a conversation is its own permission (inbox:write alone may not reassign).
    if (body.assignUserId !== undefined && !roleHasPermission(session.role, "inbox:assign")) {
      return jsonError("You don't have permission to reassign conversations.", 403);
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      include: {
        contact: { include: { identifiers: true } },
        messagingChannel: { select: { provider: true } },
        leads: { where: { deletedAt: null }, take: 1 },
      },
    });
    if (!conversation) return jsonError("Conversation not found", 404);

    // Validate everything before writing anything, so a rejected request changes nothing.
    const lead = conversation.leads[0];
    const wantsLeadChange = Boolean(body.qualificationStatus || body.stageId);
    if (wantsLeadChange && !lead) {
      return jsonError(
        "This conversation has no lead yet, so its stage or qualification can't be set.",
        409,
      );
    }

    let stageId: string | undefined;
    if (body.stageId) {
      const stage = await prisma.pipelineStage.findFirst({
        where: {
          id: body.stageId,
          pipeline: { organisationId: session.organisationId },
        },
        select: { id: true },
      });
      if (!stage) return jsonError("Stage not found", 404);
      stageId = stage.id;
    }

    if (body.assignUserId) {
      const member = await prisma.organisationMember.findFirst({
        where: {
          organisationId: session.organisationId,
          userId: body.assignUserId,
          user: { deletedAt: null, isActive: true, isSuspended: false },
        },
        select: { id: true },
      });
      if (!member) {
        return jsonError("Assignee is not a member of this organisation", 400);
      }
    }

    if (body.aiPaused !== undefined || body.handlingMode) {
      const nextHandlingMode =
        body.handlingMode ??
        (body.aiPaused === true
          ? HandlingMode.PAUSED
          : body.aiPaused === false
            ? HandlingMode.AI
            : undefined);
      // Handing back to the AI ends the handoff — otherwise the thread stays in
      // "Human required" / Attention after the person resumed AI.
      const resumingAi = body.aiPaused === false && nextHandlingMode === HandlingMode.AI;
      await prisma.conversation.updateMany({
        where: { id, organisationId: session.organisationId },
        data: {
          aiPaused: body.aiPaused,
          handlingMode: nextHandlingMode,
          needsHumanReview: body.aiPaused === true ? true : resumingAi ? false : undefined,
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

    if (lead && wantsLeadChange) {
      await prisma.lead.updateMany({
        where: { id: lead.id, organisationId: session.organisationId },
        data: {
          qualificationStatus: body.qualificationStatus,
          stageId,
          // A person's decision wins: inbound AI analysis stops overwriting it.
          metadata: markHumanLeadChange(lead.metadata, {
            stage: Boolean(stageId),
            qualification: Boolean(body.qualificationStatus),
            userId: session.userId,
          }) as Prisma.InputJsonValue,
        },
      });
    }

    if (body.reply) {
      const windowState = evaluateMessagingWindow({
        lastInboundAt: conversation.lastInboundAt,
        messagingWindowExpiresAt: conversation.messagingWindowExpiresAt,
        humanMessagingWindowExpiresAt: conversation.humanMessagingWindowExpiresAt,
        optedOut: conversation.contact.optedOut,
      });
      if (!windowState.humanReplyAllowed) {
        return jsonError(
          windowState.humanBlockedReason?.includes("opted out")
            ? "Do not contact — customer opted out."
            : windowState.humanBlockedReason || "Human messaging window has closed",
          403,
        );
      }

      const channelProvider = conversation.messagingChannel?.provider || "manychat";
      const identifier =
        conversation.contact.identifiers.find((i) => i.channel === channelProvider) ||
        conversation.contact.identifiers.find((i) => i.channel === "manychat") ||
        conversation.contact.identifiers[0];
      const idempotencyKey = humanReplyIdempotencyKey({
        conversationId: id,
        userId: session.userId,
        reply: body.reply,
        clientKey: body.replyIdempotencyKey,
      });

      const sendResult = await dispatchOutboundMessage({
        organisationId: session.organisationId,
        conversationId: id,
        contactId: conversation.contactId,
        contactExternalId: identifier
          ? identifier.identifier.replace(new RegExp(`^${channelProvider}:`), "")
          : conversation.contactId,
        content: body.reply,
        source: "HUMAN",
        actorId: session.userId,
        holder: `human:${session.userId}:${id}`,
        idempotencyKey,
        provider: channelProvider,
        channel: channelProvider,
        threadId: conversation.externalThreadId ?? undefined,
        expectedActivityVersion: body.expectedActivityVersion,
        metadata: { path: "inbox_reply" },
      });

      if (!sendResult.ok && sendResult.code !== "ALREADY_CONFIRMED") {
        if (sendResult.code === "RECONCILIATION_REQUIRED") {
          return jsonError(
            "Message may have been sent but confirmation was lost — manual review required",
            409,
          );
        }
        if (
          sendResult.code === "CONTACT_OPTED_OUT" ||
          sendResult.code === "CONTACT_SUPPRESSED" ||
          sendResult.code === "DO_NOT_CONTACT" ||
          sendResult.code === "CONVERSATION_CLOSED" ||
          sendResult.code === "MESSAGING_WINDOW_CLOSED" ||
          sendResult.code === "META_INSTAGRAM_NO_PRIOR_INBOUND" ||
          sendResult.code === "ZERNIO_NO_PRIOR_INBOUND" ||
          sendResult.code === "PROVIDER_POLICY_BLOCKED"
        ) {
          if (
            sendResult.code === "CONTACT_OPTED_OUT" ||
            sendResult.code === "DO_NOT_CONTACT" ||
            sendResult.code === "CONTACT_SUPPRESSED"
          ) {
            return jsonError("Do not contact — customer opted out.", 403);
          }
          return jsonError(
            sendResult.code === "MESSAGING_WINDOW_CLOSED"
              ? "Messaging window has closed"
              : "This reply could not be sent under current messaging rules.",
            403,
          );
        }
        if (sendResult.code === "STALE_CONTEXT") {
          return jsonError(
            "New activity in this conversation — check the latest messages, then send again.",
            409,
          );
        }
        if (sendResult.code === "FAILED" || sendResult.code === "CONNECTION_REVOKED") {
          // Definitely not delivered: the client may retry with a fresh idempotency key.
          return Response.json(
            {
              error:
                sendResult.code === "CONNECTION_REVOKED"
                  ? "Not sent — the messaging connection was disconnected. Reconnect it and try again."
                  : "Not sent — the messaging provider rejected the message. Try again.",
              notDelivered: true,
            },
            { status: 502 },
          );
        }
        return jsonError(sendResult.code || "Outbound send failed", 502);
      }

      await cancelPendingFollowUps({
        organisationId: session.organisationId,
        conversationId: id,
        reason: "Human replied",
      });

      return Response.json({
        ok: true,
        outbound: {
          code: sendResult.code,
          dispatchId: sendResult.dispatch?.id,
          messageId: sendResult.dispatch?.messageId ?? null,
        },
      });
    }

    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (error instanceof z.ZodError) {
      return jsonError(error.issues[0]?.message || "Invalid request", 400);
    }
    logger.error("Conversation patch failed", { message });
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
