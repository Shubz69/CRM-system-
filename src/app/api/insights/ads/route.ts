import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";

export async function GET() {
  try {
    const session = await requirePermission("insights:read");
    const [objections, questions] = await Promise.all([
      prisma.objection.groupBy({ by: ["category"], where: { organisationId: session.organisationId }, _count: { category: true }, orderBy: { _count: { category: "desc" } }, take: 10 }),
      prisma.detectedQuestion.groupBy({ by: ["text"], where: { organisationId: session.organisationId }, _count: { text: true }, orderBy: { _count: { text: "desc" } }, take: 5 }),
    ]);
    return Response.json({
      suggestions: [
        ...objections.map((objection) => ({ headline: `Stop letting ${objection.category} hold your team back`, angle: `Address the ${objection.category} objection with proof and a clear outcome.`, evidenceCount: objection._count.category, aiGenerated: true })),
        ...questions.map((question) => ({ headline: `The answer to: ${question.text}`, angle: "Turn this high-frequency question into a direct-response ad hook.", evidenceCount: question._count.text, aiGenerated: true })),
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
