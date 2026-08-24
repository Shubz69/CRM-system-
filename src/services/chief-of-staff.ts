/**
 * Phase 13 — Chief of Staff fact selection (deterministic).
 * LLM may later summarise these facts — never invent business state.
 */

import { prisma } from "@/lib/db";
import { getBusinessContextCompleteness } from "@/services/digital-twin";

export type CosSectionKey =
  | "WHAT_CHANGED"
  | "WHAT_MATTERS"
  | "WHAT_IS_AT_RISK"
  | "OPPORTUNITIES"
  | "RECOMMENDED_ACTIONS"
  | "WAITING_FOR_YOU";

export type CosFact = {
  id: string;
  section: CosSectionKey;
  title: string;
  detail: string;
  href?: string;
  why?: string;
  goalId?: string;
  opportunityId?: string;
  confidence?: string;
  urgency?: string;
  impact?: string;
};

export type ChiefOfStaffBriefingV2 = {
  generatedAt: string;
  organisationId: string;
  sections: Record<CosSectionKey, CosFact[]>;
  missingContext: Array<{ key: string; label: string; detail: string }>;
  /** Narrative reserved for LLM — null until explicitly generated from these facts. */
  narrative: string | null;
};

export async function buildChiefOfStaffFacts(
  organisationId: string,
): Promise<ChiefOfStaffBriefingV2> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);

  const [
    atRiskGoals,
    topOpps,
    recentOpps,
    pendingApprovals,
    activeMissions,
    recentEvents,
    completeness,
  ] = await Promise.all([
    prisma.goal.findMany({
      where: { organisationId, status: { in: ["AT_RISK", "ACTIVE"] } },
      orderBy: { priority: "asc" },
      take: 10,
    }),
    prisma.businessOpportunity.findMany({
      where: {
        organisationId,
        status: { in: ["DETECTED", "REVIEWED", "ACCEPTED"] },
      },
      orderBy: { priorityScore: "desc" },
      take: 8,
      include: { evidences: { take: 3 } },
    }),
    prisma.businessOpportunity.findMany({
      where: {
        organisationId,
        detectedAt: { gte: since },
        status: { notIn: ["EXPIRED", "DISMISSED", "REJECTED", "COMPLETED"] },
      },
      orderBy: { detectedAt: "desc" },
      take: 5,
    }),
    prisma.approvalRequest.findMany({
      where: { organisationId, status: "PENDING" },
      take: 10,
      orderBy: { createdAt: "desc" },
    }),
    prisma.agentMission.findMany({
      where: {
        organisationId,
        status: { in: ["QUEUED", "RUNNING", "WAITING_APPROVAL", "BLOCKED"] },
      },
      take: 10,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.domainEvent.findMany({
      where: { organisationId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: {
        id: true,
        eventType: true,
        aggregateType: true,
        aggregateId: true,
        createdAt: true,
      },
    }),
    getBusinessContextCompleteness(organisationId),
  ]);

  const sections: Record<CosSectionKey, CosFact[]> = {
    WHAT_CHANGED: [
      ...recentOpps.slice(0, 5).map((o) => ({
        id: `new-opp-${o.id}`,
        section: "WHAT_CHANGED" as const,
        title: `New opportunity: ${o.title}`,
        detail: `${o.type} detected ${o.detectedAt.toISOString()}`,
        href: `/opportunities/${o.id}`,
        opportunityId: o.id,
      })),
      ...recentEvents.slice(0, 8).map((e) => ({
      id: `evt-${e.id}`,
      section: "WHAT_CHANGED" as const,
      title: e.eventType,
      detail: `${e.aggregateType} ${e.aggregateId} · ${e.createdAt.toISOString()}`,
      href: "/admin/ai-ops",
    })),
    ],
    WHAT_MATTERS: [
      ...atRiskGoals
        .filter((g) => g.status === "ACTIVE")
        .slice(0, 5)
        .map((g) => ({
          id: `goal-${g.id}`,
          section: "WHAT_MATTERS" as const,
          title: g.name,
          detail: `Active goal · priority ${g.priority}`,
          href: `/goals/${g.id}`,
          goalId: g.id,
          why: "Active organisational goal",
        })),
      ...topOpps.slice(0, 3).map((o) => ({
        id: `matter-opp-${o.id}`,
        section: "WHAT_MATTERS" as const,
        title: o.title,
        detail: `Priority ${o.priorityScore} · ${o.type}`,
        href: `/opportunities/${o.id}`,
        opportunityId: o.id,
        confidence: o.confidence,
        urgency: o.urgency,
        impact: o.impact,
        why: o.evidences[0]?.label,
      })),
    ],
    WHAT_IS_AT_RISK: [
      ...atRiskGoals
        .filter((g) => g.status === "AT_RISK")
        .map((g) => ({
          id: `risk-goal-${g.id}`,
          section: "WHAT_IS_AT_RISK" as const,
          title: `Goal at risk: ${g.name}`,
          detail: g.description?.slice(0, 200) || "Marked AT_RISK",
          href: `/goals/${g.id}`,
          goalId: g.id,
        })),
      ...topOpps
        .filter((o) => o.type === "DEAL_RISK" || o.urgency === "CRITICAL" || o.urgency === "HIGH")
        .slice(0, 5)
        .map((o) => ({
          id: `risk-opp-${o.id}`,
          section: "WHAT_IS_AT_RISK" as const,
          title: o.title,
          detail: o.summary.slice(0, 240),
          href: `/opportunities/${o.id}`,
          opportunityId: o.id,
          urgency: o.urgency,
          impact: o.impact,
          confidence: o.confidence,
          why: o.evidences.map((e) => e.label).join("; "),
        })),
    ],
    OPPORTUNITIES: topOpps.map((o) => ({
      id: `opp-${o.id}`,
      section: "OPPORTUNITIES" as const,
      title: o.title,
      detail: `${o.type} · impact=${o.impact} urgency=${o.urgency} confidence=${o.confidence} score=${o.priorityScore}`,
      href: `/opportunities/${o.id}`,
      opportunityId: o.id,
      confidence: o.confidence,
      urgency: o.urgency,
      impact: o.impact,
      goalId: o.goalId ?? undefined,
      why: o.evidences.map((e) => e.label).join("; ") || "Detector evidence attached",
    })),
    RECOMMENDED_ACTIONS: [
      ...topOpps
        .filter((o) => o.status === "DETECTED" || o.status === "REVIEWED")
        .slice(0, 5)
        .map((o) => ({
          id: `act-${o.id}`,
          section: "RECOMMENDED_ACTIONS" as const,
          title: `Review: ${o.title}`,
          detail: "Accept to create a Mission, or reject with reason later",
          href: `/opportunities/${o.id}`,
          opportunityId: o.id,
          why: "Highest priority open opportunity",
        })),
    ],
    WAITING_FOR_YOU: [
      ...pendingApprovals.map((a) => ({
        id: `appr-${a.id}`,
        section: "WAITING_FOR_YOU" as const,
        title: "Pending approval",
        detail: `ApprovalRequest ${a.id}`,
        href: "/automations",
      })),
      ...activeMissions
        .filter((m) => m.status === "WAITING_APPROVAL")
        .map((m) => ({
          id: `mission-${m.id}`,
          section: "WAITING_FOR_YOU" as const,
          title: `Mission needs approval: ${m.title}`,
          detail: m.objectiveSummary.slice(0, 200),
          href: "/ask",
        })),
    ],
  };

  return {
    generatedAt: new Date().toISOString(),
    organisationId,
    sections,
    missingContext: completeness.items
      .filter((i) => i.status !== "known")
      .map((i) => ({ key: i.key, label: i.label, detail: i.detail })),
    narrative: null,
  };
}

/** Compact Ask context — relevance-budgeted, not the full twin. */
export async function assembleAskBusinessContext(input: {
  organisationId: string;
  entityType?: string;
  entityId?: string;
  maxItems?: number;
}): Promise<{
  goals: Array<{ id: string; name: string; status: string }>;
  opportunities: Array<{ id: string; title: string; priorityScore: number; type: string }>;
  missions: Array<{ id: string; title: string; status: string }>;
  completenessGaps: string[];
}> {
  const max = input.maxItems ?? 5;
  const [goals, opportunities, missions, completeness] = await Promise.all([
    prisma.goal.findMany({
      where: { organisationId: input.organisationId, status: { in: ["ACTIVE", "AT_RISK"] } },
      orderBy: { priority: "asc" },
      take: max,
      select: { id: true, name: true, status: true },
    }),
    prisma.businessOpportunity.findMany({
      where: {
        organisationId: input.organisationId,
        status: { in: ["DETECTED", "REVIEWED", "ACCEPTED", "IN_PROGRESS"] },
      },
      orderBy: { priorityScore: "desc" },
      take: max,
      select: { id: true, title: true, priorityScore: true, type: true },
    }),
    prisma.agentMission.findMany({
      where: {
        organisationId: input.organisationId,
        status: { in: ["QUEUED", "RUNNING", "WAITING_APPROVAL", "BLOCKED"] },
      },
      orderBy: { updatedAt: "desc" },
      take: max,
      select: { id: true, title: true, status: true },
    }),
    getBusinessContextCompleteness(input.organisationId),
  ]);

  return {
    goals,
    opportunities,
    missions,
    completenessGaps: completeness.items
      .filter((i) => i.status === "missing")
      .map((i) => i.label),
  };
}
