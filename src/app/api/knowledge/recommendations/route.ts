import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { recordRecommendationFeedback } from "@/services/learning-os";

export async function GET() {
  try {
    const session = await requirePermission("knowledge:manage");
    const recommendations = await prisma.knowledgeRecommendation.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return Response.json({ recommendations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["NEW", "REVIEWED", "APPROVED", "DISMISSED", "USED"]),
  draftAnswer: z.string().optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("knowledge:manage");
    const body = patchSchema.parse(await req.json());
    const existing = await prisma.knowledgeRecommendation.findFirst({
      where: { id: body.id, organisationId: session.organisationId },
    });
    if (!existing) return jsonError("Not found", 404);

    await prisma.knowledgeRecommendation.updateMany({
      where: { id: body.id, organisationId: session.organisationId },
      data: {
        status: body.status,
        draftAnswer: body.draftAnswer ?? existing.draftAnswer,
      },
    });

    const recommendation = await prisma.knowledgeRecommendation.findFirst({
      where: { id: body.id, organisationId: session.organisationId },
    });

    const signal =
      body.status === "APPROVED" || body.status === "USED"
        ? "accepted"
        : body.status === "DISMISSED"
          ? "dismissed"
          : null;
    if (signal) {
      await recordRecommendationFeedback({
        organisationId: session.organisationId,
        userId: session.userId,
        subjectKind: "knowledge_recommendation",
        subjectId: body.id,
        signal,
      });
    }

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "knowledge.recommendation_updated",
      entityType: "KnowledgeRecommendation",
      entityId: body.id,
      metadata: { status: body.status },
    });

    return Response.json({ recommendation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
