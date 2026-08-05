import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";
import { QualificationStatus, BookingStatus } from "@prisma/client";

export async function GET() {
  try {
    const session = await requirePermission("reports:read");
    const reports = await prisma.report.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return Response.json({ reports });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requirePermission("reports:read");
    const { searchParams } = new URL(req.url);
    const requestBody = await req.json().catch(() => ({})) as { type?: string };
    const type = requestBody.type === "weekly" || searchParams.get("type") === "weekly" ? "weekly" : "daily";
    const days = type === "weekly" ? 7 : 1;
    const periodEnd = new Date();
    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const generatedDay = new Date();
    generatedDay.setHours(0, 0, 0, 0);
    const nextDay = new Date(generatedDay);
    nextDay.setDate(nextDay.getDate() + 1);
    const orgId = session.organisationId;

    const dateFilter = { createdAt: { gte: periodStart, lte: periodEnd } };

    const [newConversations, qualifiedLeads, callsBooked, followUpsSent, objections, questions, attention] =
      await Promise.all([
        prisma.conversation.count({ where: { organisationId: orgId, ...dateFilter } }),
        prisma.lead.count({
          where: {
            organisationId: orgId,
            qualificationStatus: QualificationStatus.QUALIFIED,
            ...dateFilter,
          },
        }),
        prisma.booking.count({
          where: {
            organisationId: orgId,
            status: { in: [BookingStatus.CREATED, BookingStatus.ATTENDED] },
            ...dateFilter,
          },
        }),
        prisma.followUp.count({
          where: { organisationId: orgId, status: "SENT", ...dateFilter },
        }),
        prisma.objection.groupBy({
          by: ["category"],
          where: { organisationId: orgId, detectedAt: { gte: periodStart, lte: periodEnd } },
          _count: { category: true },
          orderBy: { _count: { category: "desc" } },
          take: 5,
        }),
        prisma.detectedQuestion.groupBy({
          by: ["text"],
          where: { organisationId: orgId, detectedAt: { gte: periodStart, lte: periodEnd } },
          _count: { text: true },
          orderBy: { _count: { text: "desc" } },
          take: 5,
        }),
        prisma.conversation.findMany({
          where: { organisationId: orgId, needsHumanReview: true },
          include: { contact: true },
          take: 10,
        }),
      ]);

    const payload = {
      type,
      periodStart,
      periodEnd,
      newConversations,
      qualifiedLeads,
      callsBooked,
      conversionRate: newConversations > 0 ? callsBooked / newConversations : 0,
      followUpsSent,
      topObjections: objections.map((o) => ({ category: o.category, count: o._count.category })),
      topQuestions: questions.map((q) => ({ text: q.text, count: q._count.text })),
      importantLeads: attention.map((c) => ({
        name: c.contact.fullName,
        preview: c.lastMessagePreview,
      })),
      contentSuggestions: questions.slice(0, 3).map((q) => `Create content answering: ${q.text}`),
      adSuggestions: objections.slice(0, 3).map((o) => `Ad angle addressing ${o.category} objection`),
    };

    const existing = await prisma.report.findFirst({
      where: { organisationId: orgId, type, createdAt: { gte: generatedDay, lt: nextDay } },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return Response.json({ report: existing, payload: existing.payload });
    const report = await prisma.report.create({
      data: {
        organisationId: orgId,
        type,
        periodStart,
        periodEnd,
        title: `${type === "weekly" ? "Weekly" : "Daily"} report`,
        payload,
      },
    });

    return Response.json({ report, payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
