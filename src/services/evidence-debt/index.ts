/**
 * Phase 20C — deterministic Evidence Debt.
 * Maturity: WORKING. Recommendations never execute research.
 */
import { EvidenceDebtStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isIntelligenceFlagEnabled } from "@/services/intelligence-flags";

export const EVIDENCE_DEBT_MATURITY = "WORKING" as const;

export type EvidenceDebtScoreInput = {
  importance?: string;
  freshnessBand?: string;
  confidenceBand?: string;
  independentSources?: number;
  goalDependencyCount?: number;
  opportunityDependencyCount?: number;
  decisionDependencyCount?: number;
  consequenceBand?: string;
};

const band = (value: string | undefined) => value?.trim().toUpperCase();
const clamp = (value: number) => Math.min(100, Math.max(0, value));

export function scoreEvidenceDebt(input: EvidenceDebtScoreInput): number {
  const importance = { LOW: 8, MEDIUM: 18, HIGH: 30, CRITICAL: 40 }[
    band(input.importance) ?? "MEDIUM"
  ] ?? 18;
  const freshnessDebt = { FRESH: 0, CURRENT: 0, AGING: 10, STALE: 20, UNKNOWN: 14 }[
    band(input.freshnessBand) ?? "UNKNOWN"
  ] ?? 14;
  const confidenceDebt = { HIGH: 0, MEDIUM: 7, LOW: 15, UNKNOWN: 12 }[
    band(input.confidenceBand) ?? "UNKNOWN"
  ] ?? 12;
  const sourceDebt = Math.max(0, 3 - Math.max(0, input.independentSources ?? 0)) * 5;
  const dependencies =
    Math.max(0, input.goalDependencyCount ?? 0) * 4 +
    Math.max(0, input.opportunityDependencyCount ?? 0) * 3 +
    Math.max(0, input.decisionDependencyCount ?? 0) * 5;
  const consequence = { LOW: 0, MEDIUM: 4, HIGH: 8, CRITICAL: 12 }[
    band(input.consequenceBand) ?? "MEDIUM"
  ] ?? 4;
  return clamp(importance + freshnessDebt + confidenceDebt + sourceDebt + Math.min(20, dependencies) + consequence);
}

export type EvidenceDebtAction =
  | "recommend_refresh"
  | "create_research_opportunity"
  | "request_human"
  | "schedule_cheap_refresh"
  | "none";

export function recommendAction(
  input: EvidenceDebtScoreInput & {
    priorityScore?: number;
    status?: EvidenceDebtStatus | "OPEN" | "RECOMMENDED" | "RESOLVED" | "DEPRECATED";
    evidenceDebtEnabled?: boolean;
  },
): EvidenceDebtAction {
  if (
    input.evidenceDebtEnabled === false ||
    input.status === "RESOLVED" ||
    input.status === "DEPRECATED"
  ) {
    return "none";
  }
  const score = input.priorityScore ?? scoreEvidenceDebt(input);
  const dependencyCount =
    (input.goalDependencyCount ?? 0) +
    (input.opportunityDependencyCount ?? 0) +
    (input.decisionDependencyCount ?? 0);

  if (
    score >= 75 &&
    ["HIGH", "CRITICAL"].includes(band(input.consequenceBand) ?? "") &&
    ["LOW", "UNKNOWN"].includes(band(input.confidenceBand) ?? "UNKNOWN")
  ) {
    return "request_human";
  }
  if (score >= 70 && (input.independentSources ?? 0) === 0 && dependencyCount > 0) {
    return "create_research_opportunity";
  }
  if (
    score >= 55 &&
    ["STALE", "AGING", "UNKNOWN"].includes(band(input.freshnessBand) ?? "UNKNOWN")
  ) {
    return "recommend_refresh";
  }
  if (score >= 35) return "schedule_cheap_refresh";
  return "none";
}

export type UpsertEvidenceDebtInput = EvidenceDebtScoreInput & {
  organisationId: string;
  subjectKind: string;
  subjectId: string;
  title: string;
  status?: "OPEN" | "RECOMMENDED" | "RESOLVED" | "DEPRECATED";
  metadata?: Prisma.InputJsonValue;
};

export async function upsertEvidenceDebtItem(input: UpsertEvidenceDebtInput) {
  if (
    !(await isIntelligenceFlagEnabled(
      input.organisationId,
      "evidenceDebtEnabled",
    ))
  ) {
    return null;
  }

  const status = input.status ?? "OPEN";
  const priorityScore = scoreEvidenceDebt(input);
  const recommendedAction = recommendAction({ ...input, status, priorityScore });
  const resolvedAt = status === "RESOLVED" ? new Date() : null;
  const data = {
    title: input.title,
    importance: band(input.importance) ?? "MEDIUM",
    freshnessBand: band(input.freshnessBand),
    confidenceBand: band(input.confidenceBand),
    independentSources: Math.max(0, input.independentSources ?? 0),
    goalDependencyCount: Math.max(0, input.goalDependencyCount ?? 0),
    opportunityDependencyCount: Math.max(0, input.opportunityDependencyCount ?? 0),
    decisionDependencyCount: Math.max(0, input.decisionDependencyCount ?? 0),
    consequenceBand: band(input.consequenceBand) ?? "MEDIUM",
    priorityScore,
    status: status as EvidenceDebtStatus,
    recommendedAction,
    metadata: input.metadata ?? {},
    resolvedAt,
  };

  return prisma.evidenceDebtItem.upsert({
    where: {
      organisationId_subjectKind_subjectId: {
        organisationId: input.organisationId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
      },
    },
    create: {
      organisationId: input.organisationId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      ...data,
    },
    update: data,
  });
}

export async function clearEvidenceDebt(input: {
  organisationId: string;
  subjectKind: string;
  subjectId: string;
}) {
  return prisma.evidenceDebtItem.updateMany({
    where: {
      organisationId: input.organisationId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      status: { in: [EvidenceDebtStatus.OPEN, EvidenceDebtStatus.RECOMMENDED] },
    },
    data: {
      status: EvidenceDebtStatus.RESOLVED,
      resolvedAt: new Date(),
      recommendedAction: "none",
    },
  });
}
