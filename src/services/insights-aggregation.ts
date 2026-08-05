import { BookingStatus, QualificationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";

export async function aggregateDailyInsights(organisationId: string, date: Date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  const period = { gte: start, lt: end };
  const [totalConversations, newLeads, qualifiedLeads, disqualifiedLeads, callsBooked, aiHandled, humanTakeovers, followUpsSent, objections, questions] = await Promise.all([
    prisma.conversation.count({ where: { organisationId, createdAt: period, deletedAt: null } }),
    prisma.lead.count({ where: { organisationId, createdAt: period, deletedAt: null } }),
    prisma.lead.count({ where: { organisationId, createdAt: period, qualificationStatus: QualificationStatus.QUALIFIED, deletedAt: null } }),
    prisma.lead.count({ where: { organisationId, createdAt: period, qualificationStatus: QualificationStatus.DISQUALIFIED, deletedAt: null } }),
    prisma.booking.count({ where: { organisationId, createdAt: period, status: { in: [BookingStatus.CREATED, BookingStatus.ATTENDED] } } }),
    prisma.conversation.count({ where: { organisationId, createdAt: period, handlingMode: "AI", deletedAt: null } }),
    prisma.conversation.count({ where: { organisationId, createdAt: period, OR: [{ handlingMode: "HUMAN" }, { needsHumanReview: true }], deletedAt: null } }),
    prisma.followUp.count({ where: { organisationId, sentAt: period, status: "SENT" } }),
    prisma.objection.groupBy({ by: ["category"], where: { organisationId, detectedAt: period }, _count: { category: true } }),
    prisma.detectedQuestion.groupBy({ by: ["text"], where: { organisationId, detectedAt: period }, _count: { text: true } }),
  ]);
  const metric = await prisma.dailyMetric.upsert({ where: { organisationId_date: { organisationId, date: start } }, update: { totalConversations, newLeads, qualifiedLeads, disqualifiedLeads, callsBooked, aiHandled, humanTakeovers, followUpsSent }, create: { organisationId, date: start, totalConversations, newLeads, qualifiedLeads, disqualifiedLeads, callsBooked, aiHandled, humanTakeovers, followUpsSent } });
  await prisma.conversationInsight.deleteMany({ where: { organisationId, createdAt: period, conversationId: null, type: { in: ["daily_objection", "daily_question"] } } });
  await prisma.conversationInsight.createMany({ data: [
    ...objections.map((item) => ({ organisationId, type: "daily_objection", title: item.category, summary: `Observed ${item._count.category} times on ${start.toISOString().slice(0, 10)}.`, evidenceCount: item._count.category, confidence: 0.8 })),
    ...questions.map((item) => ({ organisationId, type: "daily_question", title: item.text, summary: `Asked ${item._count.text} times on ${start.toISOString().slice(0, 10)}.`, evidenceCount: item._count.text, confidence: 0.8 })),
  ] });
  return metric;
}
