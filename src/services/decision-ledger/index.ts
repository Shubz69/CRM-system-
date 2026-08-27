/**
 * Phase 20D — durable decision memory.
 *
 * A Decision records a choice; a BusinessOpportunity records something worth
 * considering. They deliberately remain separate models.
 */
import { BusinessOpportunityType, DecisionStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const DECISION_ATTRIBUTIONS = [
  "DIRECT",
  "CONTRIBUTED",
  "CORRELATED",
  "ESTIMATED",
  "UNKNOWN",
] as const;
export type DecisionAttribution = (typeof DECISION_ATTRIBUTIONS)[number];

const MAX_RATIONALE_LENGTH = 2_000;

export class DecisionLedgerError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "INVALID_ALTERNATIVE"
      | "INVALID_ATTRIBUTION"
      | "ATTRIBUTION_HONESTY"
      | "RATIONALE_TOO_LONG",
  ) {
    super(message);
    this.name = "DecisionLedgerError";
  }
}

type AlternativeInput = {
  alternativeKey: string;
  label: string;
  summary?: string;
  expectedDirection?: string;
  potentialValueBand?: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  estimatedCostCents?: number;
  timeToImpactBand?: string;
  riskBand?: string;
  confidenceBand?: string;
  goalAlignment?: number;
  processCapacityBand?: string;
  metadata?: Record<string, unknown>;
};

type EvidenceLinkInput = {
  evidenceKind: string;
  evidenceId: string;
  role?: string;
  note?: string;
};

type RelatedEntity = { entityType: string; entityId: string };

function assertShortRationale(value: string | undefined) {
  if (value && value.length > MAX_RATIONALE_LENGTH) {
    throw new DecisionLedgerError(
      `rationaleSummary must be at most ${MAX_RATIONALE_LENGTH} characters`,
      "RATIONALE_TOO_LONG",
    );
  }
}

export async function createDecision(input: {
  organisationId: string;
  problemSummary: string;
  decisionType: string;
  alternatives: AlternativeInput[];
  evidenceLinks?: EvidenceLinkInput[];
  relatedEntities?: RelatedEntity[];
  status?: DecisionStatus;
  goalId?: string;
  kpiDefinitionId?: string;
  opportunityId?: string;
  riskBand?: string;
  confidenceBand?: string;
  uncertaintyBand?: string;
  expectedImpactDirection?: string;
  estimatedCostCents?: number;
  ownerUserId?: string;
  agentVersion?: string;
  rationaleSummary?: string;
  metadata?: Record<string, unknown>;
}) {
  if (input.alternatives.length < 2) {
    throw new DecisionLedgerError("A decision requires at least two alternatives", "INVALID_ALTERNATIVE");
  }
  if (new Set(input.alternatives.map((item) => item.alternativeKey)).size !== input.alternatives.length) {
    throw new DecisionLedgerError("alternativeKey values must be unique", "INVALID_ALTERNATIVE");
  }
  assertShortRationale(input.rationaleSummary);

  return prisma.$transaction(async (tx) => {
    const related = input.relatedEntities ?? [];
    const snapshots = related.length
      ? await tx.stateSnapshot.findMany({
          where: {
            organisationId: input.organisationId,
            OR: related.map(({ entityType, entityId }) => ({ entityType, entityId })),
          },
        })
      : [];

    return tx.decision.create({
      data: {
        organisationId: input.organisationId,
        problemSummary: input.problemSummary,
        decisionType: input.decisionType,
        status: input.status ?? DecisionStatus.DRAFT,
        goalId: input.goalId,
        kpiDefinitionId: input.kpiDefinitionId,
        opportunityId: input.opportunityId,
        riskBand: input.riskBand,
        confidenceBand: input.confidenceBand,
        uncertaintyBand: input.uncertaintyBand,
        expectedImpactDirection: input.expectedImpactDirection,
        estimatedCostCents: input.estimatedCostCents,
        ownerUserId: input.ownerUserId,
        agentVersion: input.agentVersion,
        // Structured summary only. Never persist hidden reasoning or chain-of-thought.
        rationaleSummary: input.rationaleSummary,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        alternatives: {
          create: input.alternatives.map((alternative) => ({
            organisationId: input.organisationId,
            alternativeKey: alternative.alternativeKey,
            label: alternative.label,
            summary: alternative.summary,
            expectedDirection: alternative.expectedDirection,
            potentialValueBand: alternative.potentialValueBand ?? "UNKNOWN",
            estimatedCostCents: alternative.estimatedCostCents,
            timeToImpactBand: alternative.timeToImpactBand,
            riskBand: alternative.riskBand,
            confidenceBand: alternative.confidenceBand,
            goalAlignment: alternative.goalAlignment,
            processCapacityBand: alternative.processCapacityBand,
            metadata: (alternative.metadata ?? {}) as Prisma.InputJsonValue,
          })),
        },
        evidenceLinks: {
          create: (input.evidenceLinks ?? []).map((evidence) => ({
            organisationId: input.organisationId,
            evidenceKind: evidence.evidenceKind,
            evidenceId: evidence.evidenceId,
            role: evidence.role ?? "supports",
            note: evidence.note,
          })),
        },
        stateRefs: {
          create: snapshots.map((snapshot) => ({
            organisationId: input.organisationId,
            entityType: snapshot.entityType,
            entityId: snapshot.entityId,
            dimension: snapshot.dimension,
            value: snapshot.value,
            asOf: snapshot.asOf,
            snapshotId: snapshot.id,
          })),
        },
      },
      include: { alternatives: true, evidenceLinks: true, stateRefs: true },
    });
  });
}

export async function decideAlternative(input: {
  decisionId: string;
  alternativeId: string;
  organisationId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const decision = await tx.decision.findFirst({
      where: { id: input.decisionId, organisationId: input.organisationId },
      select: { id: true },
    });
    const alternative = await tx.decisionAlternative.findFirst({
      where: {
        id: input.alternativeId,
        decisionId: input.decisionId,
        organisationId: input.organisationId,
      },
      select: { id: true },
    });
    if (!decision || !alternative) {
      throw new DecisionLedgerError("Decision or alternative not found", "NOT_FOUND");
    }

    await tx.decisionAlternative.updateMany({
      where: { decisionId: decision.id, organisationId: input.organisationId },
      data: { selected: false },
    });
    await tx.decisionAlternative.update({
      where: { id: alternative.id },
      data: { selected: true, rejected: false, rejectionReason: null },
    });
    return tx.decision.update({
      where: { id: decision.id },
      data: {
        selectedAlternativeId: alternative.id,
        status: DecisionStatus.DECIDED,
        decidedAt: new Date(),
      },
      include: { alternatives: true },
    });
  });
}

/**
 * Link only after the caller has completed all applicable policy and approval
 * checks. Selecting an alternative never creates or authorizes a mission.
 */
export async function linkMissionToDecision(input: {
  organisationId: string;
  decisionId: string;
  missionId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const [decision, mission] = await Promise.all([
      tx.decision.findFirst({
        where: { id: input.decisionId, organisationId: input.organisationId },
        select: { id: true },
      }),
      tx.agentMission.findFirst({
        where: { id: input.missionId, organisationId: input.organisationId },
        select: { id: true },
      }),
    ]);
    if (!decision || !mission) {
      throw new DecisionLedgerError("Decision or mission not found", "NOT_FOUND");
    }
    await tx.agentMission.update({
      where: { id: mission.id },
      data: { decisionId: decision.id },
    });
    return tx.decision.update({
      where: { id: decision.id },
      data: { missionId: mission.id },
    });
  });
}

export async function recordDecisionOutcome(input: {
  organisationId: string;
  decisionId: string;
  outcomeKind: string;
  outcomeRef?: string;
  kpiEffectDirection?: string;
  attribution: DecisionAttribution;
  measuredValue?: number;
  notes?: string;
  metadata?: Record<string, unknown>;
  evidence?: Array<{ kind: string; id: string }>;
}) {
  if (!(DECISION_ATTRIBUTIONS as readonly string[]).includes(input.attribution)) {
    throw new DecisionLedgerError("Invalid outcome attribution", "INVALID_ATTRIBUTION");
  }
  const hasRevenue = input.metadata?.revenueCents != null;
  if (hasRevenue && (input.attribution !== "DIRECT" || !input.evidence?.length)) {
    throw new DecisionLedgerError(
      "revenueCents requires DIRECT attribution and explicit evidence",
      "ATTRIBUTION_HONESTY",
    );
  }
  const decision = await prisma.decision.findFirst({
    where: { id: input.decisionId, organisationId: input.organisationId },
    select: { id: true },
  });
  if (!decision) throw new DecisionLedgerError("Decision not found", "NOT_FOUND");

  return prisma.decisionOutcome.create({
    data: {
      organisationId: input.organisationId,
      decisionId: decision.id,
      outcomeKind: input.outcomeKind,
      outcomeRef: input.outcomeRef,
      kpiEffectDirection: input.kpiEffectDirection,
      attribution: input.attribution,
      measuredValue: input.measuredValue,
      notes: input.notes,
    },
  });
}

export async function findSimilarDecisions(input: {
  organisationId: string;
  decisionType: string;
  goalId?: string | null;
  opportunityType?: BusinessOpportunityType;
  excludeDecisionId?: string;
  take?: number;
}) {
  // opportunityId is intentionally a scalar context link (Decision is not an
  // Opportunity), so resolve matching opportunity ids before filtering.
  const opportunityIds = input.opportunityType
    ? (
        await prisma.businessOpportunity.findMany({
          where: {
            organisationId: input.organisationId,
            type: input.opportunityType,
          },
          select: { id: true },
        })
      ).map((opportunity) => opportunity.id)
    : undefined;

  return prisma.decision.findMany({
    where: {
      organisationId: input.organisationId,
      decisionType: input.decisionType,
      ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
      ...(input.excludeDecisionId ? { id: { not: input.excludeDecisionId } } : {}),
      ...(opportunityIds ? { opportunityId: { in: opportunityIds } } : {}),
    },
    include: { alternatives: true, outcomes: true, evidenceLinks: true, stateRefs: true },
    orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
    take: Math.min(100, Math.max(1, input.take ?? 20)),
  });
}
