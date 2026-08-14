import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";
import { QualificationStatus, BookingStatus } from "@prisma/client";

export async function GET(req: Request) {
  try {
    const session = await requirePermission("insights:read");
    const { searchParams } = new URL(req.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const dateFilter = {
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };

    const orgId = session.organisationId;

    const [
      totalConversations,
      newLeads,
      qualifiedLeads,
      disqualifiedLeads,
      callsBooked,
      aiHandled,
      humanTakeovers,
      followUpsSent,
      objections,
      questions,
      highValueLeads,
      needsAttention,
      recentBookings,
    ] = await Promise.all([
      prisma.conversation.count({ where: { organisationId: orgId, deletedAt: null, ...dateFilter } }),
      prisma.lead.count({ where: { organisationId: orgId, deletedAt: null, ...dateFilter } }),
      prisma.lead.count({
        where: {
          organisationId: orgId,
          deletedAt: null,
          qualificationStatus: QualificationStatus.QUALIFIED,
          ...dateFilter,
        },
      }),
      prisma.lead.count({
        where: {
          organisationId: orgId,
          deletedAt: null,
          qualificationStatus: QualificationStatus.DISQUALIFIED,
          ...dateFilter,
        },
      }),
      prisma.booking.count({
        where: {
          organisationId: orgId,
          status: { in: [BookingStatus.CREATED, BookingStatus.ATTENDED, BookingStatus.RESCHEDULED] },
          ...dateFilter,
        },
      }),
      prisma.conversation.count({
        where: { organisationId: orgId, handlingMode: "AI", deletedAt: null, ...dateFilter },
      }),
      prisma.conversation.count({
        where: {
          organisationId: orgId,
          OR: [{ handlingMode: "HUMAN" }, { needsHumanReview: true }],
          deletedAt: null,
          ...dateFilter,
        },
      }),
      prisma.followUp.count({
        where: { organisationId: orgId, status: "SENT", ...dateFilter },
      }),
      prisma.objection.groupBy({
        by: ["category"],
        where: { organisationId: orgId },
        _count: { category: true },
        orderBy: { _count: { category: "desc" } },
        take: 5,
      }),
      prisma.detectedQuestion.groupBy({
        by: ["text"],
        where: { organisationId: orgId },
        _count: { text: true },
        orderBy: { _count: { text: "desc" } },
        take: 5,
      }),
      prisma.lead.findMany({
        where: { organisationId: orgId, deletedAt: null, score: { gte: 70 } },
        include: { contact: true, stage: true },
        orderBy: { score: "desc" },
        take: 5,
      }),
      prisma.conversation.findMany({
        where: {
          organisationId: orgId,
          deletedAt: null,
          OR: [{ needsHumanReview: true }, { aiPaused: true }],
        },
        include: { contact: true, leads: { take: 1 } },
        orderBy: { updatedAt: "desc" },
        take: 8,
      }),
      prisma.booking.findMany({
        where: { organisationId: orgId },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

    const bookingConversion = newLeads > 0 ? callsBooked / newLeads : 0;
    const leadToBooking = qualifiedLeads > 0 ? callsBooked / qualifiedLeads : 0;
    const humanTakeoverRate = totalConversations > 0 ? humanTakeovers / totalConversations : 0;

    return Response.json({
      metrics: {
        totalConversations,
        newLeads,
        qualifiedLeads,
        disqualifiedLeads,
        callsBooked,
        bookingConversionRate: bookingConversion,
        leadToBookingConversionRate: leadToBooking,
        averageResponseTimeSec: null,
        aiHandledConversations: aiHandled,
        humanTakeoverRate,
        followUpsSent,
      },
      topObjections: objections.map((o) => ({
        category: o.category,
        count: o._count.category,
      })),
      topQuestions: questions.map((q) => ({
        text: q.text,
        count: q._count.text,
      })),
      highValueLeads: highValueLeads.map((l) => ({
        id: l.id,
        name: l.contact.fullName,
        username: l.contact.instagramUsername,
        score: l.score,
        stage: l.stage?.name,
      })),
      needsAttention: needsAttention.map((c) => ({
        id: c.id,
        name: c.contact.fullName,
        preview: c.lastMessagePreview,
        score: c.leads[0]?.score ?? 0,
      })),
      recentBookings,
      funnel: {
        newLeads,
        engaged: await prisma.lead.count({
          where: {
            organisationId: orgId,
            deletedAt: null,
            stage: { slug: { in: ["engaged", "contacted", "qualifying"] } },
          },
        }),
        qualified: qualifiedLeads,
        booked: callsBooked,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
