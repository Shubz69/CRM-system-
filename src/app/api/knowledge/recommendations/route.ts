import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { upsertKnowledgeDocument } from "@/services/knowledge";
import { recordRecommendationFeedback } from "@/services/learning-os";

/** Gaps still waiting on the team. APPROVED / DISMISSED / USED are closed. */
const OPEN_RECOMMENDATION_STATUSES = ["NEW", "REVIEWED"];

export async function GET() {
  try {
    const session = await requirePermission("knowledge:manage");
    const recommendations = await prisma.knowledgeRecommendation.findMany({
      where: {
        organisationId: session.organisationId,
        status: { in: OPEN_RECOMMENDATION_STATUSES },
      },
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
  draftAnswer: z.string().max(20_000).optional(),
  /** Optional overrides for the Knowledge document created on approve. */
  title: z.string().trim().max(180).optional(),
  category: z.string().trim().max(60).optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("knowledge:manage");
    const body = patchSchema.parse(await req.json());
    const existing = await prisma.knowledgeRecommendation.findFirst({
      where: { id: body.id, organisationId: session.organisationId },
    });
    if (!existing) return jsonError("Not found", 404);

    const draftAnswer = body.draftAnswer ?? existing.draftAnswer;

    // Approving a gap means answering it: the answer becomes a Knowledge document (chunked and
    // retrievable via the knowledge service) before the recommendation is closed.
    let documentId: string | null = null;
    if (body.status === "APPROVED") {
      const answer = (draftAnswer ?? "").trim();
      if (!answer) {
        return jsonError("Add an answer before approving — it is saved to Knowledge for the AI to use.", 400);
      }
      documentId = await upsertKnowledgeDocument({
        organisationId: session.organisationId,
        title: (body.title || existing.question).trim().slice(0, 180),
        category: body.category || "faq",
        content: `Q: ${existing.question.trim()}\n\nA: ${answer}`,
        tags: ["knowledge-gap"],
      });
    }

    await prisma.knowledgeRecommendation.updateMany({
      where: { id: body.id, organisationId: session.organisationId },
      data: {
        status: body.status,
        draftAnswer,
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
      metadata: { status: body.status, documentId },
    });

    return Response.json({ recommendation, documentId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
