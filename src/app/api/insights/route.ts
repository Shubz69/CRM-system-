import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";

export async function GET() {
  try {
    const session = await requirePermission("insights:read");
    const orgId = session.organisationId;

    const [objections, questions, buyingSignals, knowledgeGaps, disqualified, campaigns] =
      await Promise.all([
        prisma.objection.groupBy({
          by: ["category"],
          where: { organisationId: orgId },
          _count: { category: true },
          orderBy: { _count: { category: "desc" } },
          take: 10,
        }),
        prisma.detectedQuestion.groupBy({
          by: ["text"],
          where: { organisationId: orgId },
          _count: { text: true },
          orderBy: { _count: { text: "desc" } },
          take: 10,
        }),
        prisma.buyingSignal.groupBy({
          by: ["text"],
          where: { organisationId: orgId },
          _count: { text: true },
          orderBy: { _count: { text: "desc" } },
          take: 10,
        }),
        prisma.conversation.findMany({
          where: {
            organisationId: orgId,
            needsHumanReview: true,
          },
          select: { id: true, summary: true, intent: true },
          take: 10,
        }),
        prisma.lead.findMany({
          where: { organisationId: orgId, qualificationStatus: "DISQUALIFIED" },
          select: { summary: true, scoreExplanation: true },
          take: 20,
        }),
        prisma.lead.groupBy({
          by: ["campaignId"],
          where: { organisationId: orgId, campaignId: { not: null } },
          _count: { campaignId: true },
          _avg: { score: true },
        }),
      ]);

    const insights = [
      {
        type: "objection",
        title: "Most common objections",
        evidenceCount: objections.reduce((s, o) => s + o._count.category, 0),
        trend: "stable",
        confidence: objections.length ? 0.8 : 0.3,
        recommendedAction: "Update objection-handling scripts in Knowledge",
        items: objections.map((o) => ({ label: o.category, count: o._count.category })),
      },
      {
        type: "question",
        title: "Top prospect questions",
        evidenceCount: questions.reduce((s, q) => s + q._count.text, 0),
        trend: "up",
        confidence: questions.length ? 0.85 : 0.3,
        recommendedAction: "Turn frequent questions into FAQ and ad copy",
        items: questions.map((q) => ({ label: q.text, count: q._count.text })),
      },
      {
        type: "buying_signal",
        title: "Buying signals",
        evidenceCount: buyingSignals.reduce((s, b) => s + b._count.text, 0),
        trend: "up",
        confidence: buyingSignals.length ? 0.75 : 0.3,
        recommendedAction: "Trigger booking offer when these phrases appear",
        items: buyingSignals.map((b) => ({ label: b.text, count: b._count.text })),
      },
      {
        type: "knowledge_gap",
        title: "Conversations where AI struggled",
        evidenceCount: knowledgeGaps.length,
        trend: "stable",
        confidence: 0.7,
        recommendedAction: "Add missing SOPs/FAQs for these intents",
        items: knowledgeGaps.map((g) => ({
          label: g.intent || g.summary || g.id,
          count: 1,
        })),
      },
      {
        type: "disqualification",
        title: "Common disqualification patterns",
        evidenceCount: disqualified.length,
        trend: "stable",
        confidence: disqualified.length ? 0.65 : 0.3,
        recommendedAction: "Tighten ad targeting to reduce poor-fit leads",
        items: disqualified.slice(0, 5).map((d) => ({
          label: d.summary || d.scoreExplanation || "Disqualified lead",
          count: 1,
        })),
      },
      {
        type: "content",
        title: "Suggested content angles",
        evidenceCount: questions.length + objections.length,
        trend: "up",
        confidence: 0.6,
        recommendedAction: "Create content addressing top questions and objections",
        items: [
          ...questions.slice(0, 3).map((q) => ({ label: `Content: ${q.text}`, count: q._count.text })),
          ...objections.slice(0, 3).map((o) => ({
            label: `Ad angle: overcome ${o.category}`,
            count: o._count.category,
          })),
        ],
      },
    ];

    return Response.json({
      insights,
      campaigns: campaigns.map((c) => ({
        campaignId: c.campaignId,
        leads: c._count.campaignId,
        avgScore: c._avg.score,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
