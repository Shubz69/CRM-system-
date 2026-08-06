import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";

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

    const updated = await prisma.knowledgeRecommendation.update({
      where: { id: body.id },
      data: {
        status: body.status,
        draftAnswer: body.draftAnswer ?? existing.draftAnswer,
      },
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "knowledge.recommendation_updated",
      entityType: "KnowledgeRecommendation",
      entityId: updated.id,
      metadata: { status: body.status },
    });

    return Response.json({ recommendation: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
