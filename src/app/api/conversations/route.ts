import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";
import { logger } from "@/lib/logger";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function GET(req: Request) {
  try {
    const session = await requirePermission("inbox:read");
    const { searchParams } = new URL(req.url);
    const where: Prisma.ConversationWhereInput = {
      organisationId: session.organisationId,
      deletedAt: null,
      // A deleted contact's threads leave the inbox and its counts.
      contact: { deletedAt: null },
    };

    // Overview pages only need numbers — real counts, not the length of a capped list.
    if (searchParams.get("summary") === "1") {
      const [total, needingHuman, needsReply] = await Promise.all([
        prisma.conversation.count({ where }),
        prisma.conversation.count({
          where: { ...where, OR: [{ needsHumanReview: true }, { handlingMode: "HUMAN" }] },
        }),
        // Same rule as the inbox "Needs reply" queue: the customer spoke last.
        prisma.conversation.count({
          where: {
            ...where,
            OR: [
              { lastInboundAt: { gt: prisma.conversation.fields.lastOutboundAt } },
              { lastOutboundAt: null, lastInboundAt: { not: null } },
            ],
          },
        }),
      ]);
      return Response.json({ total, needingHuman, needsReply });
    }

    // `limit` grows with the inbox's "Load more" (the poll re-reads the loaded range).
    const limit = parseLimit(searchParams.get("limit"));
    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        // Polled every 8s by the inbox — select only the fields the list renders
        // (was full Contact/Conversation rows incl. JSON metadata).
        select: {
          id: true,
          unreadCount: true,
          lastMessagePreview: true,
          lastMessageAt: true,
          handlingMode: true,
          aiPaused: true,
          needsHumanReview: true,
          lastInboundAt: true,
          lastOutboundAt: true,
          messagingWindowExpiresAt: true,
          humanMessagingWindowExpiresAt: true,
          intent: true,
          sentiment: true,
          summary: true,
          contact: { select: { fullName: true, instagramUsername: true } },
          leads: {
            where: { deletedAt: null },
            take: 1,
            select: {
              id: true,
              score: true,
              qualificationStatus: true,
              stageId: true,
              stage: { select: { name: true } },
            },
          },
          assignments: {
            where: { active: true },
            select: { user: { select: { id: true, name: true, email: true } } },
          },
          tags: { select: { tag: { select: { name: true } } } },
        },
        orderBy: { lastMessageAt: "desc" },
        take: limit,
      }),
      prisma.conversation.count({ where }),
    ]);

    return Response.json({
      total,
      limit,
      conversations: conversations.map((c) => ({
        id: c.id,
        contactName: c.contact.fullName,
        instagramUsername: c.contact.instagramUsername,
        unreadCount: c.unreadCount,
        lastMessagePreview: c.lastMessagePreview,
        lastMessageAt: c.lastMessageAt,
        handlingMode: c.handlingMode,
        aiPaused: c.aiPaused,
        needsHumanReview: c.needsHumanReview,
        lastInboundAt: c.lastInboundAt,
        lastOutboundAt: c.lastOutboundAt,
        messagingWindowExpiresAt: c.messagingWindowExpiresAt,
        humanMessagingWindowExpiresAt: c.humanMessagingWindowExpiresAt,
        intent: c.intent,
        sentiment: c.sentiment,
        summary: c.summary,
        lead: c.leads[0]
          ? {
              id: c.leads[0].id,
              score: c.leads[0].score,
              qualificationStatus: c.leads[0].qualificationStatus,
              stage: c.leads[0].stage?.name,
              stageId: c.leads[0].stageId,
            }
          : null,
        tags: c.tags.map((t) => t.tag.name),
        assignee: c.assignments[0]?.user ?? null,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    logger.error("List conversations failed", { message });
    return jsonError(message, 500);
  }
}
