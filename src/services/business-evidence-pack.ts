/**
 * Compact organisation-scoped evidence pack for Quick / Operator.
 * Deterministic facts only — no model recalculation of counts.
 */
import { prisma } from "@/lib/db";

export type EvidenceFact = {
  key: string;
  value: string | number | boolean | null;
  source: string;
  recordId?: string;
};

export type BusinessEvidencePack = {
  organisationId: string;
  generatedAt: string;
  facts: EvidenceFact[];
  summaryLines: string[];
  byteEstimate: number;
};

const STALE_MS = 14 * 24 * 60 * 60 * 1000;

export async function buildBusinessEvidencePack(
  organisationId: string,
): Promise<BusinessEvidencePack> {
  const now = Date.now();
  const [
    contactCount,
    companyCount,
    openDeals,
    conversations,
    goals,
    contentInReview,
    pendingApprovals,
    hotLeads,
  ] = await Promise.all([
    prisma.contact.count({ where: { organisationId, deletedAt: null } }),
    prisma.company.count({ where: { organisationId, deletedAt: null } }),
    prisma.deal.findMany({
      where: { organisationId, deletedAt: null, status: "OPEN" },
      orderBy: { updatedAt: "asc" },
      take: 20,
      select: { id: true, name: true, stageLabel: true, amountCents: true, updatedAt: true },
    }),
    prisma.conversation.findMany({
      where: { organisationId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 30,
      select: {
        id: true,
        unreadCount: true,
        needsHumanReview: true,
        handlingMode: true,
        contact: { select: { fullName: true, instagramUsername: true } },
      },
    }),
    prisma.goal.findMany({
      where: { organisationId, status: { in: ["AT_RISK", "ACTIVE"] } },
      take: 15,
      select: { id: true, name: true, status: true },
    }),
    prisma.contentPiece.findMany({
      where: { organisationId, status: "IN_REVIEW" },
      take: 10,
      select: { id: true, title: true, status: true },
    }),
    prisma.approvalRequest
      .findMany({
        where: { organisationId, status: "PENDING" },
        take: 10,
        select: { id: true, title: true, kind: true },
      })
      .catch(() => [] as Array<{ id: string; title: string | null; kind: string }>),
    prisma.lead
      .findMany({
        where: { organisationId, deletedAt: null, score: { gt: 0 } },
        orderBy: [{ score: "desc" }],
        take: 5,
        select: { id: true, score: true, contact: { select: { fullName: true } } },
      })
      .catch(() => [] as Array<{ id: string; score: number | null; contact: { fullName: string | null } | null }>),
  ]);

  const stalled = openDeals.filter((d) => now - d.updatedAt.getTime() >= STALE_MS);
  const needingReply = conversations.filter(
    (c) => (c.unreadCount ?? 0) > 0 || c.needsHumanReview,
  );
  const needingHuman = conversations.filter(
    (c) => c.needsHumanReview || c.handlingMode === "HUMAN",
  );
  const goalsAtRisk = goals.filter((g) => g.status === "AT_RISK");
  const contentWaiting = [
    ...contentInReview.map((c) => ({ id: c.id, title: c.title || "Untitled" })),
    ...pendingApprovals.map((a) => ({
      id: a.id,
      title: a.title || `${a.kind || "Item"} awaiting approval`,
    })),
  ];

  const facts: EvidenceFact[] = [
    { key: "contacts.count", value: contactCount, source: "Contact.count" },
    { key: "companies.count", value: companyCount, source: "Company.count" },
    { key: "deals.openCount", value: openDeals.length, source: "Deal.findMany(OPEN)" },
    { key: "deals.stalledCount", value: stalled.length, source: "Deal.updatedAt>=14d" },
    {
      key: "inbox.needingReplyCount",
      value: needingReply.length,
      source: "Conversation.unread|needsHuman",
    },
    {
      key: "inbox.needingHumanCount",
      value: needingHuman.length,
      source: "Conversation.needsHuman|HUMAN",
    },
    { key: "goals.atRiskCount", value: goalsAtRisk.length, source: "Goal.AT_RISK" },
    { key: "content.awaitingApprovalCount", value: contentWaiting.length, source: "Content|Approval" },
    { key: "leads.positiveScoreCount", value: hotLeads.length, source: "Lead.score>0" },
  ];

  for (const d of stalled.slice(0, 5)) {
    facts.push({
      key: "deals.stalled",
      value: `${d.name} (${d.stageLabel || "no stage"})`,
      source: "Deal",
      recordId: d.id,
    });
  }
  for (const c of needingReply.slice(0, 5)) {
    facts.push({
      key: "inbox.needingReply",
      value: c.contact?.fullName || c.contact?.instagramUsername || "Unknown",
      source: "Conversation",
      recordId: c.id,
    });
  }
  for (const g of goalsAtRisk.slice(0, 5)) {
    facts.push({
      key: "goals.atRisk",
      value: g.name,
      source: "Goal",
      recordId: g.id,
    });
  }
  for (const p of contentWaiting.slice(0, 5)) {
    facts.push({
      key: "content.awaitingApproval",
      value: p.title,
      source: "ContentPiece|ApprovalRequest",
      recordId: p.id,
    });
  }
  for (const l of hotLeads.slice(0, 3)) {
    facts.push({
      key: "leads.hot",
      value: `${l.contact?.fullName || "Lead"} (score ${l.score})`,
      source: "Lead",
      recordId: l.id,
    });
  }

  const summaryLines = [
    `Contacts: ${contactCount}; Companies: ${companyCount}.`,
    `Open deals: ${openDeals.length}; Stalled (≥14d): ${stalled.length}.`,
    `Inbox needing reply: ${needingReply.length}; needing human: ${needingHuman.length}.`,
    `Goals at risk: ${goalsAtRisk.length}; Content awaiting approval: ${contentWaiting.length}.`,
    `Positive-score leads: ${hotLeads.length}.`,
  ];

  const pack: BusinessEvidencePack = {
    organisationId,
    generatedAt: new Date().toISOString(),
    facts,
    summaryLines,
    byteEstimate: 0,
  };
  pack.byteEstimate = JSON.stringify(pack).length;
  return pack;
}
