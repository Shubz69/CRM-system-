import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { recordRecommendationFeedback } from "@/services/learning-os";

const schema = z.object({
  subjectKind: z.string().min(1),
  subjectId: z.string().min(1),
  signal: z.enum([
    "helpful",
    "not_helpful",
    "accepted",
    "dismissed",
    "outcome_positive",
    "outcome_negative",
  ]),
  rating: z.number().int().min(1).max(5).optional().nullable(),
  note: z.string().optional().nullable(),
  outcomeMetric: z.string().optional().nullable(),
  outcomeValue: z.number().optional().nullable(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("insights:read");
    const body = schema.parse(await req.json());
    const feedback = await recordRecommendationFeedback({
      organisationId: session.organisationId,
      userId: session.userId,
      ...body,
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "learning.feedback_recorded",
      entityType: "RecommendationFeedback",
      entityId: feedback.id,
      metadata: { signal: body.signal, subjectKind: body.subjectKind },
    });
    return Response.json({ feedback });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
