/**
 * Phase 20E — relational business-value tracing.
 *
 * This is a query graph over existing Prisma relations, not a second graph
 * database. Attribution is carried through unchanged and never upgraded.
 */
import { prisma } from "@/lib/db";

type ValueTraceInput =
  | { organisationId: string; decisionId: string; opportunityId?: never; missionId?: never }
  | { organisationId: string; opportunityId: string; decisionId?: never; missionId?: never }
  | { organisationId: string; missionId: string; decisionId?: never; opportunityId?: never };

export class BusinessValueError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "BusinessValueError";
  }
}

export async function traceValuePath(input: ValueTraceInput) {
  let decisionId = input.decisionId;
  let opportunityId = input.opportunityId;
  let missionId = input.missionId;

  if (missionId) {
    const mission = await prisma.agentMission.findFirst({
      where: { id: missionId, organisationId: input.organisationId },
      select: { id: true, decisionId: true, businessOpportunityId: true },
    });
    if (!mission) throw new BusinessValueError("Mission not found");
    decisionId = mission.decisionId ?? undefined;
    opportunityId = mission.businessOpportunityId ?? undefined;
  }

  if (decisionId) {
    const decision = await prisma.decision.findFirst({
      where: { id: decisionId, organisationId: input.organisationId },
      include: {
        outcomes: true,
        missions: { select: { id: true, businessOpportunityId: true } },
      },
    });
    if (!decision) throw new BusinessValueError("Decision not found");
    opportunityId = opportunityId ?? decision.opportunityId ?? undefined;
    missionId = missionId ?? decision.missions[0]?.id ?? decision.missionId ?? undefined;

    const refs = [
      decision.id,
      ...decision.outcomes.flatMap((outcome) => [outcome.id, outcome.outcomeRef].filter(Boolean)),
      ...(missionId ? [missionId] : []),
      ...(opportunityId ? [opportunityId] : []),
    ] as string[];
    const costLinks = await prisma.costOutcomeLink.findMany({
      where: { organisationId: input.organisationId, outcomeRef: { in: refs } },
      orderBy: { createdAt: "asc" },
    });
    return {
      linkedIds: {
        decisionIds: [decision.id],
        opportunityIds: opportunityId ? [opportunityId] : [],
        missionIds: missionId ? [missionId] : [],
        outcomeIds: decision.outcomes.map((outcome) => outcome.id),
        costOutcomeLinkIds: costLinks.map((link) => link.id),
      },
      attributions: {
        decisionOutcomes: decision.outcomes.map((outcome) => ({
          outcomeId: outcome.id,
          attribution: outcome.attribution,
        })),
        costOutcomes: costLinks.map((link) => ({
          linkId: link.id,
          attribution: link.attribution,
        })),
      },
      attributionStatus:
        decision.outcomes.length || costLinks.length ? ("EVIDENCED" as const) : ("UNKNOWN" as const),
    };
  }

  if (opportunityId) {
    const opportunity = await prisma.businessOpportunity.findFirst({
      where: { id: opportunityId, organisationId: input.organisationId },
      select: { id: true },
    });
    if (!opportunity) throw new BusinessValueError("Opportunity not found");
    const [decisions, missions, costLinks] = await Promise.all([
      prisma.decision.findMany({
        where: { organisationId: input.organisationId, opportunityId },
        select: { id: true },
      }),
      prisma.agentMission.findMany({
        where: { organisationId: input.organisationId, businessOpportunityId: opportunityId },
        select: { id: true, decisionId: true },
      }),
      prisma.costOutcomeLink.findMany({
        where: { organisationId: input.organisationId, outcomeRef: opportunityId },
      }),
    ]);
    return {
      linkedIds: {
        decisionIds: [...new Set([...decisions.map((row) => row.id), ...missions.flatMap((row) => row.decisionId ? [row.decisionId] : [])])],
        opportunityIds: [opportunity.id],
        missionIds: missions.map((row) => row.id),
        outcomeIds: [],
        costOutcomeLinkIds: costLinks.map((row) => row.id),
      },
      attributions: {
        decisionOutcomes: [],
        costOutcomes: costLinks.map((link) => ({ linkId: link.id, attribution: link.attribution })),
      },
      attributionStatus: costLinks.length ? ("EVIDENCED" as const) : ("UNKNOWN" as const),
    };
  }

  throw new BusinessValueError("Exactly one starting id is required");
}

export async function summarizeOrgValue(input: {
  organisationId: string;
  since: Date;
}) {
  const [costLinks, outcomes] = await Promise.all([
    prisma.costOutcomeLink.findMany({
      where: { organisationId: input.organisationId, createdAt: { gte: input.since } },
    }),
    prisma.decisionOutcome.findMany({
      where: { organisationId: input.organisationId, recordedAt: { gte: input.since } },
    }),
  ]);

  const totalCostCents = costLinks.reduce((total, row) => total + row.costCents, 0);
  const directOutcomes = outcomes.filter(
    (row) => row.attribution === "DIRECT" && row.measuredValue != null,
  );
  const measuredValue = directOutcomes.reduce((total, row) => total + (row.measuredValue ?? 0), 0);
  const sufficient = directOutcomes.length > 0;

  return {
    since: input.since,
    totalCostCents,
    measuredValue: sufficient ? measuredValue : null,
    valueStatus: sufficient ? ("MEASURED_DIRECT" as const) : ("UNKNOWN" as const),
    attributionCounts: [...costLinks, ...outcomes].reduce<Record<string, number>>(
      (counts, row) => {
        counts[row.attribution] = (counts[row.attribution] ?? 0) + 1;
        return counts;
      },
      {},
    ),
    evidenceCounts: {
      costOutcomeLinks: costLinks.length,
      decisionOutcomes: outcomes.length,
      directMeasuredOutcomes: directOutcomes.length,
    },
    note: sufficient
      ? "Only directly attributed measured values are aggregated."
      : "UNKNOWN: insufficient directly attributed measured outcomes.",
  };
}
