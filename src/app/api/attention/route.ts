import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";

export async function GET() {
  try {
    const session = await requirePermission("inbox:read");
    const orgId = session.organisationId;

    const [handoffs, lowConfidence, hotLeads, knowledgeGaps, failedJobs, disconnected, bookings] =
      await Promise.all([
        prisma.conversation.findMany({
          where: {
            organisationId: orgId,
            deletedAt: null,
            OR: [{ needsHumanReview: true }, { handlingMode: "HUMAN" }],
          },
          include: { contact: true },
          orderBy: { updatedAt: "desc" },
          take: 40,
        }),
        prisma.conversation.findMany({
          where: {
            organisationId: orgId,
            deletedAt: null,
            handoffReason: { contains: "confidence", mode: "insensitive" },
          },
          include: { contact: true },
          take: 20,
        }),
        prisma.lead.findMany({
          where: { organisationId: orgId, deletedAt: null, score: { gte: 70 } },
          include: { contact: true, stage: true },
          orderBy: { score: "desc" },
          take: 20,
        }),
        prisma.knowledgeRecommendation.findMany({
          where: { organisationId: orgId, status: "NEW" },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        prisma.failedJob.findMany({
          where: { organisationId: orgId, resolvedAt: null },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        prisma.integration.findMany({
          where: { organisationId: orgId, isActive: false },
          take: 10,
        }),
        prisma.booking.findMany({
          where: {
            organisationId: orgId,
            status: { in: ["CANCELLED", "NO_SHOW"] },
          },
          include: { contact: true },
          orderBy: { updatedAt: "desc" },
          take: 10,
        }),
      ]);

    const items = [
      ...handoffs.map((c) => ({
        id: `handoff-${c.id}`,
        type: c.handoffReason?.toLowerCase().includes("speak")
          ? "customer_requested_human"
          : "human_handoff",
        title: c.contact.fullName || "Conversation",
        detail: c.handoffReason || c.lastMessagePreview || "Needs human review",
        href: `/inbox?conversationId=${c.id}`,
        severity: "high" as const,
        createdAt: c.updatedAt.toISOString(),
      })),
      ...hotLeads.map((l) => ({
        id: `hot-${l.id}`,
        type: "high_value_lead",
        title: l.contact.fullName || "Hot lead",
        detail: `Score ${l.score}${l.stage ? ` · ${l.stage.name}` : ""}`,
        href: `/pipeline`,
        severity: "medium" as const,
        createdAt: l.updatedAt.toISOString(),
      })),
      ...knowledgeGaps.map((k) => ({
        id: `gap-${k.id}`,
        type: "knowledge_missing",
        title: "Knowledge gap",
        detail: k.question,
        href: `/knowledge`,
        severity: "medium" as const,
        createdAt: k.createdAt.toISOString(),
      })),
      ...failedJobs.map((j) => ({
        id: `job-${j.id}`,
        type: "system_problem",
        title: `Failed job: ${j.jobName}`,
        detail: j.error.slice(0, 160),
        href: `/admin/failed-jobs`,
        severity: "high" as const,
        createdAt: j.createdAt.toISOString(),
      })),
      ...disconnected.map((i) => ({
        id: `int-${i.id}`,
        type: "integration_disconnected",
        title: `${i.type} disconnected`,
        detail: i.name,
        href: `/settings`,
        severity: "high" as const,
        createdAt: i.updatedAt.toISOString(),
      })),
      ...bookings.map((b) => ({
        id: `book-${b.id}`,
        type: "booking_problem",
        title: `Booking ${b.status.toLowerCase()}`,
        detail: b.contact.fullName || b.bookingUrl || "Booking issue",
        href: `/pipeline`,
        severity: "medium" as const,
        createdAt: b.updatedAt.toISOString(),
      })),
      ...lowConfidence.map((c) => ({
        id: `low-${c.id}`,
        type: "ai_confidence_low",
        title: c.contact.fullName || "Low confidence",
        detail: c.handoffReason || "AI confidence too low",
        href: `/inbox?conversationId=${c.id}`,
        severity: "medium" as const,
        createdAt: c.updatedAt.toISOString(),
      })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    // Dedupe by id
    const seen = new Set<string>();
    const unique = items.filter((i) => {
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });

    return Response.json({ count: unique.length, items: unique.slice(0, 80) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
