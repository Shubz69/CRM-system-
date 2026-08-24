/**
 * Phase 13C — BusinessOpportunity lifecycle + Mission conversion.
 */

import {
  BusinessOpportunityStatus,
  BusinessOpportunityType,
  OpportunityOutcomeResult,
  type BusinessOpportunity,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { appendDomainEvent } from "@/services/domain-events/append";
import { maybeVerifyOpportunityAfterDetect } from "@/services/intelligence-quality/opportunity";
import { createMission } from "@/services/mission-runtime";
import { assertOpportunityTransition, computePriorityScore } from "@/services/opportunities/scoring";

const OPEN_STATUSES: BusinessOpportunityStatus[] = [
  "DETECTED",
  "REVIEWED",
  "ACCEPTED",
  "PLANNED",
  "IN_PROGRESS",
];

export async function upsertDetectedOpportunity(input: {
  organisationId: string;
  type: BusinessOpportunityType;
  title: string;
  summary: string;
  dedupeKey: string;
  source: string;
  impact: BusinessOpportunity["impact"];
  urgency: BusinessOpportunity["urgency"];
  confidence: BusinessOpportunity["confidence"];
  goalId?: string;
  kpiDefinitionId?: string;
  estimatedValueCents?: number;
  currency?: string;
  estimatedEffort?: string;
  goalAlignment?: number;
  effortFactor?: number;
  expiresAt?: Date;
  createdByAgent?: string;
  evidences: Array<{
    evidenceType: string;
    evidenceId?: string;
    label: string;
    detail?: string;
  }>;
  scoreFactorsExtra?: Record<string, unknown>;
}): Promise<{ opportunity: BusinessOpportunity; created: boolean; updated: boolean; suppressed: boolean }> {
  if (input.evidences.length === 0) {
    throw new Error("Opportunity requires at least one evidence item");
  }
  if (input.goalId) {
    const g = await prisma.goal.findFirst({
      where: { id: input.goalId, organisationId: input.organisationId },
    });
    if (!g) throw new Error("Goal not found in organisation");
  }

  const { score, factors } = computePriorityScore({
    impact: input.impact,
    urgency: input.urgency,
    confidence: input.confidence,
    goalAlignment: input.goalAlignment,
    effortFactor: input.effortFactor,
  });

  const existing = await prisma.businessOpportunity.findFirst({
    where: { organisationId: input.organisationId, dedupeKey: input.dedupeKey },
  });

  if (existing && !OPEN_STATUSES.includes(existing.status)) {
    // Closed/expired — do not reopen automatically; suppress duplicate create.
    return { opportunity: existing, created: false, updated: false, suppressed: true };
  }

  if (existing) {
    const updated = await prisma.businessOpportunity.update({
      where: { id: existing.id },
      data: {
        title: input.title,
        summary: input.summary,
        impact: input.impact,
        urgency: input.urgency,
        confidence: input.confidence,
        priorityScore: score,
        estimatedValueCents: input.estimatedValueCents,
        currency: input.currency,
        expiresAt: input.expiresAt,
        scoreFactors: {
          ...factors,
          ...(input.scoreFactorsExtra ?? {}),
        } as Prisma.InputJsonValue,
      },
    });
    await maybeVerifyOpportunityAfterDetect({
      organisationId: input.organisationId,
      opportunityId: updated.id,
      evidences: input.evidences,
    });
    return { opportunity: updated, created: false, updated: true, suppressed: false };
  }

  const opportunity = await prisma.$transaction(async (tx) => {
    const opp = await tx.businessOpportunity.create({
      data: {
        organisationId: input.organisationId,
        type: input.type,
        title: input.title,
        summary: input.summary,
        status: BusinessOpportunityStatus.DETECTED,
        impact: input.impact,
        urgency: input.urgency,
        confidence: input.confidence,
        priorityScore: score,
        estimatedValueCents: input.estimatedValueCents,
        currency: input.currency,
        estimatedEffort: input.estimatedEffort,
        goalId: input.goalId,
        kpiDefinitionId: input.kpiDefinitionId,
        source: input.source,
        dedupeKey: input.dedupeKey,
        expiresAt: input.expiresAt,
        createdByAgent: input.createdByAgent ?? "detector",
        scoreFactors: {
          ...factors,
          ...(input.scoreFactorsExtra ?? {}),
        } as Prisma.InputJsonValue,
        evidences: {
          create: input.evidences.map((e) => ({
            organisationId: input.organisationId,
            evidenceType: e.evidenceType,
            evidenceId: e.evidenceId,
            label: e.label,
            detail: e.detail,
          })),
        },
      },
    });
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "OPPORTUNITY_DETECTED",
      aggregateType: "BusinessOpportunity",
      aggregateId: opp.id,
      payload: {
        opportunityId: opp.id,
        type: opp.type,
        title: opp.title,
      },
      dedupeKey: `opp-detected:${opp.id}`,
    });
    return opp;
  });

  await maybeVerifyOpportunityAfterDetect({
    organisationId: input.organisationId,
    opportunityId: opportunity.id,
    evidences: input.evidences,
  });

  return { opportunity, created: true, updated: false, suppressed: false };
}

export async function listOpportunities(
  organisationId: string,
  filters?: { status?: BusinessOpportunityStatus; type?: BusinessOpportunityType },
) {
  return prisma.businessOpportunity.findMany({
    where: {
      organisationId,
      status: filters?.status,
      type: filters?.type,
    },
    orderBy: [{ priorityScore: "desc" }, { detectedAt: "desc" }],
    include: { evidences: true, goal: { select: { id: true, name: true, status: true } } },
    take: 100,
  });
}

export async function getOpportunityForOrg(organisationId: string, opportunityId: string) {
  return prisma.businessOpportunity.findFirst({
    where: { id: opportunityId, organisationId },
    include: {
      evidences: true,
      outcome: true,
      goal: true,
      missions: { select: { id: true, title: true, status: true }, take: 5 },
    },
  });
}

export async function transitionOpportunity(input: {
  organisationId: string;
  opportunityId: string;
  to: BusinessOpportunityStatus;
  actorUserId?: string;
}): Promise<BusinessOpportunity> {
  return prisma.$transaction(async (tx) => {
    const opp = await tx.businessOpportunity.findFirst({
      where: { id: input.opportunityId, organisationId: input.organisationId },
    });
    if (!opp) throw new Error("Opportunity not found");
    assertOpportunityTransition(opp.status, input.to);
    const data: Prisma.BusinessOpportunityUpdateInput = {
      status: input.to,
      reviewedAt: ["REVIEWED", "ACCEPTED", "REJECTED"].includes(input.to)
        ? new Date()
        : undefined,
      acceptedAt: input.to === "ACCEPTED" ? new Date() : undefined,
      rejectedAt: input.to === "REJECTED" ? new Date() : undefined,
      completedAt: input.to === "COMPLETED" ? new Date() : undefined,
      executedAt: input.to === "IN_PROGRESS" ? new Date() : undefined,
    };
    const updated = await tx.businessOpportunity.update({
      where: { id: opp.id },
      data,
    });
    if (input.to === "ACCEPTED") {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "OPPORTUNITY_ACCEPTED",
        aggregateType: "BusinessOpportunity",
        aggregateId: opp.id,
        payload: { opportunityId: opp.id, type: opp.type },
        actorType: "user",
        actorId: input.actorUserId,
      });
    }
    if (input.to === "REJECTED") {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "OPPORTUNITY_REJECTED",
        aggregateType: "BusinessOpportunity",
        aggregateId: opp.id,
        payload: { opportunityId: opp.id, type: opp.type },
        actorType: "user",
        actorId: input.actorUserId,
      });
    }
    if (input.to === "EXPIRED") {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "OPPORTUNITY_EXPIRED",
        aggregateType: "BusinessOpportunity",
        aggregateId: opp.id,
        payload: { opportunityId: opp.id, type: opp.type },
      });
    }
    if (input.to === "COMPLETED") {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "OPPORTUNITY_COMPLETED",
        aggregateType: "BusinessOpportunity",
        aggregateId: opp.id,
        payload: { opportunityId: opp.id, type: opp.type },
        actorType: "user",
        actorId: input.actorUserId,
      });
    }
    return updated;
  });
}

/** Accept opportunity and create a Mission (durable before Redis enqueue). */
export async function acceptOpportunityAsMission(input: {
  organisationId: string;
  opportunityId: string;
  actorUserId?: string;
}) {
  const opp = await prisma.businessOpportunity.findFirst({
    where: { id: input.opportunityId, organisationId: input.organisationId },
    include: { evidences: true },
  });
  if (!opp) throw new Error("Opportunity not found");
  if (opp.status !== "DETECTED" && opp.status !== "REVIEWED" && opp.status !== "ACCEPTED") {
    throw new Error(`Cannot create mission from status ${opp.status}`);
  }

  if (opp.status === "DETECTED" || opp.status === "REVIEWED") {
    await transitionOpportunity({
      organisationId: input.organisationId,
      opportunityId: opp.id,
      to: "ACCEPTED",
      actorUserId: input.actorUserId,
    });
  }

  const mission = await createMission({
    organisationId: input.organisationId,
    title: `Opportunity: ${opp.title}`,
    objectiveSummary: opp.summary,
    planSummary: `Mission from BusinessOpportunity ${opp.id} (${opp.type})`,
    goalId: opp.goalId ?? undefined,
    createdByUserId: input.actorUserId,
    tasks: [
      {
        idempotencyKey: `opp-${opp.id}-assess`,
        title: "Assess opportunity evidence",
      },
      {
        idempotencyKey: `opp-${opp.id}-act`,
        title: "Execute recommended action",
        dependsOnKeys: [`opp-${opp.id}-assess`],
      },
    ],
  });

  await prisma.agentMission.update({
    where: { id: mission.id },
    data: { businessOpportunityId: opp.id },
  });

  await transitionOpportunity({
    organisationId: input.organisationId,
    opportunityId: opp.id,
    to: "IN_PROGRESS",
    actorUserId: input.actorUserId,
  });

  return { opportunityId: opp.id, missionId: mission.id };
}

export async function recordOpportunityOutcome(input: {
  organisationId: string;
  opportunityId: string;
  result: OpportunityOutcomeResult;
  summary?: string;
  measuredValueCents?: number;
  currency?: string;
  userJudgement?: string;
}) {
  const opp = await prisma.businessOpportunity.findFirst({
    where: { id: input.opportunityId, organisationId: input.organisationId },
  });
  if (!opp) throw new Error("Opportunity not found");
  if (input.measuredValueCents != null && !input.currency) {
    throw new Error("measuredValueCents requires currency");
  }
  return prisma.opportunityOutcome.upsert({
    where: { opportunityId: opp.id },
    create: {
      organisationId: input.organisationId,
      opportunityId: opp.id,
      result: input.result,
      summary: input.summary,
      measuredValueCents: input.measuredValueCents,
      currency: input.currency,
      userJudgement: input.userJudgement,
    },
    update: {
      result: input.result,
      summary: input.summary,
      measuredValueCents: input.measuredValueCents,
      currency: input.currency,
      userJudgement: input.userJudgement,
    },
  });
}

export async function expireDueOpportunities(organisationId?: string) {
  const now = new Date();
  const due = await prisma.businessOpportunity.findMany({
    where: {
      organisationId,
      expiresAt: { lte: now },
      status: { in: OPEN_STATUSES },
    },
    take: 100,
  });
  let n = 0;
  for (const opp of due) {
    await transitionOpportunity({
      organisationId: opp.organisationId,
      opportunityId: opp.id,
      to: "EXPIRED",
    });
    n += 1;
  }
  return n;
}
