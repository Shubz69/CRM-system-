import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";

export async function GET() {
  try {
    const session = await requirePermission("insights:read");
    const [questions, objections] = await Promise.all([
      prisma.detectedQuestion.groupBy({ by: ["text"], where: { organisationId: session.organisationId }, _count: { text: true }, orderBy: { _count: { text: "desc" } }, take: 10 }),
      prisma.objection.groupBy({ by: ["category"], where: { organisationId: session.organisationId }, _count: { category: true }, orderBy: { _count: { category: "desc" } }, take: 5 }),
    ]);
    const suggestions = [
      ...questions.map((question) => ({ title: `Answer: ${question.text}`, type: "FAQ or educational post", evidenceCount: question._count.text, evidence: question.text, aiGenerated: true })),
      ...objections.map((objection) => ({ title: `How to overcome ${objection.category}`, type: "Objection-handling post", evidenceCount: objection._count.category, evidence: objection.category, aiGenerated: true })),
    ];
    return Response.json({ suggestions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
