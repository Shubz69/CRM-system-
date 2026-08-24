/**
 * Opportunity detector registry — Postgres sweep only, no new BullMQ worker.
 */

import { BusinessOpportunityType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  evaluateTargetProgress,
  listGoals,
} from "@/services/goals";
import { upsertDetectedOpportunity } from "@/services/opportunities/lifecycle";
import {
  deriveConfidence,
  deriveImpact,
  deriveUrgency,
} from "@/services/opportunities/scoring";

export type DetectorContext = {
  organisationId: string;
};

export type DetectorResult = {
  created: number;
  updated: number;
  suppressed: number;
};

export type OpportunityDetector = {
  key: string;
  version: string;
  opportunityType: BusinessOpportunityType;
  run: (ctx: DetectorContext) => Promise<DetectorResult>;
};

const DEAL_INACTIVE_DAYS = Number(process.env.OPP_DEAL_INACTIVE_DAYS || 7);
const LEAD_INACTIVE_DAYS = Number(process.env.OPP_LEAD_INACTIVE_DAYS || 14);
const OBJECTION_MIN_COUNT = Number(process.env.OPP_OBJECTION_MIN_COUNT || 3);

const dealRiskDetector: OpportunityDetector = {
  key: "deal_risk",
  version: "1",
  opportunityType: "DEAL_RISK",
  async run({ organisationId }) {
    const cutoff = new Date(Date.now() - DEAL_INACTIVE_DAYS * 24 * 60 * 60_000);
    const deals = await prisma.deal.findMany({
      where: {
        organisationId,
        deletedAt: null,
        status: "OPEN",
        OR: [
          { amountCents: { gte: 5_000_00 } },
          { expectedCloseAt: { lte: new Date(Date.now() + 30 * 24 * 60 * 60_000) } },
        ],
      },
      take: 50,
    });

    let created = 0;
    let updated = 0;
    let suppressed = 0;

    for (const deal of deals) {
      const lastActivity = await prisma.crmActivity.findFirst({
        where: { organisationId, dealId: deal.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, id: true },
      });
      const lastAt = lastActivity?.createdAt ?? deal.updatedAt;
      if (lastAt > cutoff) continue;

      const daysInactive = Math.floor((Date.now() - lastAt.getTime()) / (24 * 60 * 60_000));
      const daysToDeadline = deal.expectedCloseAt
        ? Math.floor((deal.expectedCloseAt.getTime() - Date.now()) / (24 * 60 * 60_000))
        : null;

      const confidence = deriveConfidence({
        independentSignals: lastActivity ? 2 : 1,
        dataFresh: true,
        sourceQuality: "high",
      });
      const impact = deriveImpact({ dealValueCents: deal.amountCents });
      const urgency = deriveUrgency({ daysInactive, daysToDeadline });

      const result = await upsertDetectedOpportunity({
        organisationId,
        type: "DEAL_RISK",
        title: `Inactive high-value deal: ${deal.name}`,
        summary: `Open deal has had no CRM activity for ${daysInactive} day(s). Amount: ${
          deal.amountCents != null ? `${deal.amountCents} cents` : "unknown"
        }.`,
        dedupeKey: `deal_risk:v1:${deal.id}`,
        source: "detector:deal_risk",
        impact,
        urgency,
        confidence,
        estimatedValueCents: deal.amountCents ?? undefined,
        currency: deal.currency,
        createdByAgent: "deal_risk",
        evidences: [
          {
            evidenceType: "Deal",
            evidenceId: deal.id,
            label: "Open deal",
            detail: `status=${deal.status}; amountCents=${deal.amountCents ?? "null"}`,
          },
          {
            evidenceType: "CrmActivity",
            evidenceId: lastActivity?.id,
            label: "Last activity age",
            detail: `lastAt=${lastAt.toISOString()}; daysInactive=${daysInactive}`,
          },
        ],
      });
      if (result.created) created += 1;
      else if (result.updated) updated += 1;
      else if (result.suppressed) suppressed += 1;
    }

    return { created, updated, suppressed };
  },
};

const leadReactivationDetector: OpportunityDetector = {
  key: "lead_reactivation",
  version: "1",
  opportunityType: "REACTIVATION",
  async run({ organisationId }) {
    const cutoff = new Date(Date.now() - LEAD_INACTIVE_DAYS * 24 * 60 * 60_000);
    const leads = await prisma.lead.findMany({
      where: {
        organisationId,
        deletedAt: null,
        OR: [{ score: { gte: 70 } }, { stage: { slug: "qualified" } }],
        updatedAt: { lt: cutoff },
      },
      include: { stage: true, contact: { select: { id: true, fullName: true } } },
      take: 50,
    });

    let created = 0;
    let updated = 0;
    let suppressed = 0;

    for (const lead of leads) {
      const daysInactive = Math.floor(
        (Date.now() - lead.updatedAt.getTime()) / (24 * 60 * 60_000),
      );
      const confidence = deriveConfidence({
        independentSignals: 1,
        dataFresh: true,
        sourceQuality: "medium",
      });
      const impact = deriveImpact({});
      const urgency = deriveUrgency({ daysInactive });

      const result = await upsertDetectedOpportunity({
        organisationId,
        type: "REACTIVATION",
        title: `Reactivate qualified lead`,
        summary: `Qualified/high-fit lead inactive for ${daysInactive} day(s) (score=${lead.score ?? "n/a"}, stage=${lead.stage?.slug ?? "n/a"}).`,
        dedupeKey: `reactivation:v1:${lead.id}`,
        source: "detector:lead_reactivation",
        impact,
        urgency,
        confidence,
        createdByAgent: "lead_reactivation",
        evidences: [
          {
            evidenceType: "Lead",
            evidenceId: lead.id,
            label: "Qualified lead",
            detail: `score=${lead.score}; stage=${lead.stage?.slug}`,
          },
        ],
      });
      if (result.created) created += 1;
      else if (result.updated) updated += 1;
      else if (result.suppressed) suppressed += 1;
    }

    return { created, updated, suppressed };
  },
};

const audienceObjectionDetector: OpportunityDetector = {
  key: "audience_objection",
  version: "1",
  opportunityType: "AUDIENCE_NEED",
  async run({ organisationId }) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const grouped = await prisma.objection.groupBy({
      by: ["category"],
      where: { organisationId, detectedAt: { gte: since } },
      _count: { _all: true },
    });

    let created = 0;
    let updated = 0;
    let suppressed = 0;

    for (const row of grouped) {
      if (row._count._all < OBJECTION_MIN_COUNT) continue;
      const sample = await prisma.objection.findFirst({
        where: { organisationId, category: row.category, detectedAt: { gte: since } },
        orderBy: { detectedAt: "desc" },
      });
      const confidence = deriveConfidence({
        independentSignals: Math.min(3, row._count._all),
        dataFresh: true,
        sourceQuality: "medium",
      });
      const result = await upsertDetectedOpportunity({
        organisationId,
        type: "AUDIENCE_NEED",
        title: `Repeated objection: ${row.category}`,
        summary: `${row._count._all} occurrences of objection category "${row.category}" in the last 30 days.`,
        dedupeKey: `audience_objection:v1:${row.category}`,
        source: "detector:audience_objection",
        impact: "MEDIUM",
        urgency: "MEDIUM",
        confidence,
        createdByAgent: "audience_objection",
        evidences: [
          {
            evidenceType: "Objection",
            evidenceId: sample?.id,
            label: `Category ${row.category}`,
            detail: `count=${row._count._all}; sample=${sample?.text?.slice(0, 200) ?? ""}`,
          },
        ],
      });
      if (result.created) created += 1;
      else if (result.updated) updated += 1;
      else if (result.suppressed) suppressed += 1;
    }

    return { created, updated, suppressed };
  },
};

const kpiAtRiskDetector: OpportunityDetector = {
  key: "kpi_at_risk",
  version: "1",
  opportunityType: "OPERATIONAL",
  async run({ organisationId }) {
    const goals = await listGoals(organisationId);
    let created = 0;
    let updated = 0;
    let suppressed = 0;

    for (const goal of goals) {
      if (goal.status !== "ACTIVE" && goal.status !== "AT_RISK") continue;
      for (const target of goal.kpiTargets) {
        const latest = await prisma.kpiSnapshot.findFirst({
          where: {
            organisationId,
            kpiDefinitionId: target.kpiDefinitionId,
          },
          orderBy: { observedAt: "desc" },
        });
        if (!latest) continue;

        const progress = evaluateTargetProgress({
          comparator: target.comparator,
          targetValue: target.targetValue,
          targetValueMax: target.targetValueMax,
          baselineValue: target.baselineValue,
          currentValue: latest.value,
          direction: target.kpiDefinition.direction,
        });
        if (!progress.behind) continue;

        const daysToDeadline = target.deadlineAt
          ? Math.floor((target.deadlineAt.getTime() - Date.now()) / (24 * 60 * 60_000))
          : null;
        const confidence = deriveConfidence({
          independentSignals: 2,
          dataFresh: Date.now() - latest.observedAt.getTime() < 7 * 24 * 60 * 60_000,
          sourceQuality: "high",
        });
        const gapRatio =
          target.targetValue === 0 ? 1 : Math.abs(progress.gap) / Math.abs(target.targetValue);
        const impact = deriveImpact({
          goalPriority: goal.priority,
          kpiGapRatio: gapRatio,
        });
        const urgency = deriveUrgency({ daysToDeadline });

        const result = await upsertDetectedOpportunity({
          organisationId,
          type: "OPERATIONAL",
          title: `KPI behind target: ${target.kpiDefinition.name}`,
          summary: `Goal "${goal.name}" KPI "${target.kpiDefinition.name}" is behind target (current=${latest.value} ${latest.unit}, target=${target.targetValue}).`,
          dedupeKey: `kpi_at_risk:v1:${goal.id}:${target.kpiDefinitionId}`,
          source: "detector:kpi_at_risk",
          impact,
          urgency,
          confidence,
          goalId: goal.id,
          kpiDefinitionId: target.kpiDefinitionId,
          goalAlignment: 1.3,
          createdByAgent: "kpi_at_risk",
          evidences: [
            {
              evidenceType: "KpiSnapshot",
              evidenceId: latest.id,
              label: "Latest KPI snapshot",
              detail: `value=${latest.value}; unit=${latest.unit}; observedAt=${latest.observedAt.toISOString()}`,
            },
            {
              evidenceType: "KpiTarget",
              evidenceId: target.id,
              label: "Target",
              detail: `comparator=${target.comparator}; target=${target.targetValue}; unit=${target.unit}`,
            },
          ],
        });
        if (result.created) created += 1;
        else if (result.updated) updated += 1;
        else if (result.suppressed) suppressed += 1;
      }
    }

    return { created, updated, suppressed };
  },
};

export const OPPORTUNITY_DETECTORS: OpportunityDetector[] = [
  dealRiskDetector,
  leadReactivationDetector,
  audienceObjectionDetector,
  kpiAtRiskDetector,
];

export async function runOpportunityDetectorsForOrg(organisationId: string) {
  const totals = { created: 0, updated: 0, suppressed: 0 };
  for (const detector of OPPORTUNITY_DETECTORS) {
    const run = await prisma.opportunityDetectorRun.create({
      data: {
        organisationId,
        detectorKey: detector.key,
        detectorVersion: detector.version,
      },
    });
    try {
      const result = await detector.run({ organisationId });
      await prisma.opportunityDetectorRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          createdCount: result.created,
          updatedCount: result.updated,
          suppressedCount: result.suppressed,
        },
      });
      totals.created += result.created;
      totals.updated += result.updated;
      totals.suppressed += result.suppressed;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      logger.error("Opportunity detector failed", {
        organisationId,
        detector: detector.key,
        message,
      });
      await prisma.opportunityDetectorRun.update({
        where: { id: run.id },
        data: { finishedAt: new Date(), errorSummary: message },
      });
    }
  }
  return totals;
}

/** Sweep all orgs (bounded). */
export async function runOpportunityDetectorSweep(limitOrgs = 50) {
  const orgs = await prisma.organisation.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    select: { id: true },
    take: limitOrgs,
    orderBy: { updatedAt: "desc" },
  });
  let created = 0;
  let updated = 0;
  let suppressed = 0;
  for (const org of orgs) {
    const r = await runOpportunityDetectorsForOrg(org.id);
    created += r.created;
    updated += r.updated;
    suppressed += r.suppressed;
  }
  logger.info("Opportunity detector sweep complete", {
    orgs: orgs.length,
    created,
    updated,
    suppressed,
  });
  return { orgs: orgs.length, created, updated, suppressed };
}
