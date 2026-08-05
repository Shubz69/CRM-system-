import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await requirePermission("inbox:read");
    const conversations = await prisma.conversation.findMany({
      where: {
        organisationId: session.organisationId,
        deletedAt: null,
      },
      include: {
        contact: true,
        leads: {
          where: { deletedAt: null },
          take: 1,
          include: { stage: true },
        },
        assignments: {
          where: { active: true },
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        tags: { include: { tag: true } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 100,
    });

    return Response.json({
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
