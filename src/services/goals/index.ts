/**
 * Phase 13A — Goals, KPI targets/snapshots, initiatives.
 */

import {
  GoalCategory,
  GoalLinkKind,
  GoalStatus,
  InitiativeStatus,
  KpiTargetComparator,
  type Goal,
  type KpiDefinition,
  type KpiSnapshot,
  type KpiTarget,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { appendDomainEvent } from "@/services/domain-events/append";
import { getKpiCalculator } from "@/services/goals/calculators";
import {
  assertGoalAchievedAllowed,
  assertGoalTransition,
} from "@/services/goals/state";

function assertSameUnit(a: string, b: string) {
  if (a !== b) {
    throw new Error(`Unit mismatch: ${a} vs ${b}`);
  }
}

export async function createGoal(input: {
  organisationId: string;
  name: string;
  description?: string;
  category?: GoalCategory;
  priority?: number;
  ownerUserId?: string;
  parentGoalId?: string;
  startAt?: Date;
  targetAt?: Date;
  createdByUserId?: string;
  correlationId?: string;
}): Promise<Goal> {
  return prisma.$transaction(async (tx) => {
    if (input.parentGoalId) {
      const parent = await tx.goal.findFirst({
        where: { id: input.parentGoalId, organisationId: input.organisationId },
      });
      if (!parent) throw new Error("Parent goal not found in organisation");
    }
    const goal = await tx.goal.create({
      data: {
        organisationId: input.organisationId,
        name: input.name,
        description: input.description,
        category: input.category ?? GoalCategory.CUSTOM,
        status: GoalStatus.DRAFT,
        priority: input.priority ?? 100,
        ownerUserId: input.ownerUserId,
        parentGoalId: input.parentGoalId,
        startAt: input.startAt,
        targetAt: input.targetAt,
        createdByUserId: input.createdByUserId,
        source: "user",
      },
    });
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "GOAL_CREATED",
      aggregateType: "Goal",
      aggregateId: goal.id,
      payload: { goalId: goal.id, name: goal.name, category: goal.category },
      correlationId: input.correlationId,
      actorType: "user",
      actorId: input.createdByUserId,
    });
    return goal;
  });
}

export async function listGoals(organisationId: string) {
  return prisma.goal.findMany({
    where: { organisationId },
    orderBy: [{ status: "asc" }, { priority: "asc" }, { createdAt: "desc" }],
    include: {
      kpiTargets: { include: { kpiDefinition: true } },
      initiatives: { where: { status: { in: ["DRAFT", "ACTIVE"] } }, take: 10 },
    },
  });
}

export async function getGoalForOrg(organisationId: string, goalId: string) {
  return prisma.goal.findFirst({
    where: { id: goalId, organisationId },
    include: {
      kpiTargets: { include: { kpiDefinition: true } },
      initiatives: true,
      links: true,
      opportunities: {
        where: { status: { in: ["DETECTED", "REVIEWED", "ACCEPTED", "IN_PROGRESS"] } },
        orderBy: { priorityScore: "desc" },
        take: 20,
      },
    },
  });
}

export async function updateGoal(input: {
  organisationId: string;
  goalId: string;
  name?: string;
  description?: string | null;
  category?: GoalCategory;
  priority?: number;
  ownerUserId?: string | null;
  startAt?: Date | null;
  targetAt?: Date | null;
}): Promise<Goal> {
  const existing = await prisma.goal.findFirst({
    where: { id: input.goalId, organisationId: input.organisationId },
  });
  if (!existing) throw new Error("Goal not found");
  return prisma.goal.update({
    where: { id: existing.id },
    data: {
      name: input.name ?? undefined,
      description: input.description === undefined ? undefined : input.description,
      category: input.category ?? undefined,
      priority: input.priority ?? undefined,
      ownerUserId: input.ownerUserId === undefined ? undefined : input.ownerUserId,
      startAt: input.startAt === undefined ? undefined : input.startAt,
      targetAt: input.targetAt === undefined ? undefined : input.targetAt,
    },
  });
}

export async function transitionGoalStatus(input: {
  organisationId: string;
  goalId: string;
  to: GoalStatus;
  actorUserId?: string;
  /** Required when marking ACHIEVED — KPI evidence already verified by caller. */
  evidenceMet?: boolean;
  correlationId?: string;
}): Promise<Goal> {
  return prisma.$transaction(async (tx) => {
    const goal = await tx.goal.findFirst({
      where: { id: input.goalId, organisationId: input.organisationId },
    });
    if (!goal) throw new Error("Goal not found");
    assertGoalTransition(goal.status, input.to);
    if (input.to === GoalStatus.ACHIEVED) {
      assertGoalAchievedAllowed(Boolean(input.evidenceMet));
    }
    const updated = await tx.goal.update({
      where: { id: goal.id },
      data: {
        status: input.to,
        completedAt: input.to === GoalStatus.ACHIEVED ? new Date() : goal.completedAt,
      },
    });
    if (input.to === GoalStatus.ACTIVE && goal.status === GoalStatus.DRAFT) {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "GOAL_ACTIVATED",
        aggregateType: "Goal",
        aggregateId: goal.id,
        payload: { goalId: goal.id },
        correlationId: input.correlationId,
        actorType: "user",
        actorId: input.actorUserId,
      });
    }
    if (input.to === GoalStatus.ACHIEVED) {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "GOAL_ACHIEVED",
        aggregateType: "Goal",
        aggregateId: goal.id,
        payload: { goalId: goal.id },
        correlationId: input.correlationId,
        actorType: "user",
        actorId: input.actorUserId,
      });
    }
    return updated;
  });
}

export async function createKpiDefinition(input: {
  organisationId: string;
  key: string;
  name: string;
  description?: string;
  unit: string;
  calculatorKey: string;
  measurementFreq?: string;
}): Promise<KpiDefinition> {
  const calc = getKpiCalculator(input.calculatorKey);
  if (!calc) throw new Error(`Unknown KPI calculator: ${input.calculatorKey}`);
  assertSameUnit(input.unit, calc.unit);
  const existing = await prisma.kpiDefinition.findFirst({
    where: { organisationId: input.organisationId, key: input.key },
  });
  if (existing) return existing;
  return prisma.kpiDefinition.create({
    data: {
      organisationId: input.organisationId,
      key: input.key,
      name: input.name,
      description: input.description,
      unit: input.unit,
      calculatorKey: input.calculatorKey,
      measurementFreq: input.measurementFreq ?? "daily",
    },
  });
}

export async function attachKpiTarget(input: {
  organisationId: string;
  goalId: string;
  kpiDefinitionId: string;
  comparator?: KpiTargetComparator;
  targetValue: number;
  targetValueMax?: number;
  baselineValue?: number;
  unit: string;
  currency?: string;
  deadlineAt?: Date;
}): Promise<KpiTarget> {
  const [goal, kpi] = await Promise.all([
    prisma.goal.findFirst({ where: { id: input.goalId, organisationId: input.organisationId } }),
    prisma.kpiDefinition.findFirst({
      where: { id: input.kpiDefinitionId, organisationId: input.organisationId },
    }),
  ]);
  if (!goal) throw new Error("Goal not found");
  if (!kpi) throw new Error("KPI definition not found");
  assertSameUnit(input.unit, kpi.unit);
  if (input.comparator === KpiTargetComparator.RANGE && input.targetValueMax == null) {
    throw new Error("RANGE targets require targetValueMax");
  }
  return prisma.kpiTarget.create({
    data: {
      organisationId: input.organisationId,
      goalId: input.goalId,
      kpiDefinitionId: input.kpiDefinitionId,
      comparator: input.comparator ?? KpiTargetComparator.GTE,
      targetValue: input.targetValue,
      targetValueMax: input.targetValueMax,
      baselineValue: input.baselineValue,
      unit: input.unit,
      currency: input.currency,
      deadlineAt: input.deadlineAt,
    },
  });
}

export async function recordKpiSnapshot(input: {
  organisationId: string;
  kpiDefinitionId: string;
  value: number;
  unit: string;
  observedAt?: Date;
  source: string;
  sourceReference?: string;
  confidence?: number;
  calculationVersion?: string;
  metadata?: Record<string, unknown>;
  emitEvent?: boolean;
}): Promise<KpiSnapshot> {
  const kpi = await prisma.kpiDefinition.findFirst({
    where: { id: input.kpiDefinitionId, organisationId: input.organisationId },
  });
  if (!kpi) throw new Error("KPI definition not found");
  assertSameUnit(input.unit, kpi.unit);

  return prisma.$transaction(async (tx) => {
    const snap = await tx.kpiSnapshot.create({
      data: {
        organisationId: input.organisationId,
        kpiDefinitionId: input.kpiDefinitionId,
        value: input.value,
        unit: input.unit,
        observedAt: input.observedAt ?? new Date(),
        source: input.source,
        sourceReference: input.sourceReference,
        confidence: input.confidence,
        calculationVersion: input.calculationVersion ?? "1",
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    if (input.emitEvent !== false) {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "KPI_SNAPSHOT_RECORDED",
        aggregateType: "KpiDefinition",
        aggregateId: kpi.id,
        payload: {
          kpiDefinitionId: kpi.id,
          snapshotId: snap.id,
          value: snap.value,
          unit: snap.unit,
        },
      });
    }
    return snap;
  });
}

/** Run calculator and append a historical snapshot (never overwrite). */
export async function refreshKpiFromCalculator(input: {
  organisationId: string;
  kpiDefinitionId: string;
}): Promise<KpiSnapshot> {
  const kpi = await prisma.kpiDefinition.findFirst({
    where: { id: input.kpiDefinitionId, organisationId: input.organisationId },
  });
  if (!kpi) throw new Error("KPI definition not found");
  const calc = getKpiCalculator(kpi.calculatorKey);
  if (!calc) throw new Error(`Unknown calculator ${kpi.calculatorKey}`);
  const result = await calc.calculate(input.organisationId);
  assertSameUnit(result.unit, kpi.unit);
  return recordKpiSnapshot({
    organisationId: input.organisationId,
    kpiDefinitionId: kpi.id,
    value: result.value,
    unit: result.unit,
    source: `calculator:${calc.key}`,
    sourceReference: result.sourceReference,
    confidence: result.confidence,
    metadata: { freshness: result.freshness, ...(result.metadata ?? {}) },
  });
}

export function evaluateTargetProgress(input: {
  comparator: KpiTargetComparator;
  targetValue: number;
  targetValueMax?: number | null;
  baselineValue?: number | null;
  currentValue: number;
  direction: "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
}): { met: boolean; gap: number; behind: boolean } {
  const { comparator, targetValue, targetValueMax, currentValue } = input;
  switch (comparator) {
    case "GTE": {
      const met = currentValue >= targetValue;
      return { met, gap: targetValue - currentValue, behind: !met };
    }
    case "LTE": {
      const met = currentValue <= targetValue;
      return { met, gap: currentValue - targetValue, behind: !met };
    }
    case "EQ": {
      const met = currentValue === targetValue;
      return { met, gap: Math.abs(targetValue - currentValue), behind: !met };
    }
    case "RANGE": {
      const max = targetValueMax ?? targetValue;
      const met = currentValue >= targetValue && currentValue <= max;
      return { met, gap: met ? 0 : Math.min(Math.abs(currentValue - targetValue), Math.abs(currentValue - max)), behind: !met };
    }
    case "PCT_IMPROVEMENT": {
      const baseline = input.baselineValue ?? 0;
      const improved =
        input.direction === "HIGHER_IS_BETTER"
          ? baseline === 0
            ? currentValue > 0
            : (currentValue - baseline) / Math.abs(baseline) >= targetValue / 100
          : baseline === 0
            ? currentValue < 0
            : (baseline - currentValue) / Math.abs(baseline) >= targetValue / 100;
      return { met: improved, gap: 0, behind: !improved };
    }
    case "ABS_IMPROVEMENT": {
      const baseline = input.baselineValue ?? 0;
      const delta =
        input.direction === "HIGHER_IS_BETTER"
          ? currentValue - baseline
          : baseline - currentValue;
      const met = delta >= targetValue;
      return { met, gap: targetValue - delta, behind: !met };
    }
    default:
      return { met: false, gap: 0, behind: true };
  }
}

export async function createInitiative(input: {
  organisationId: string;
  name: string;
  description?: string;
  goalId?: string;
  campaignId?: string;
  experimentId?: string;
  missionId?: string;
  status?: InitiativeStatus;
}): Promise<{ id: string }> {
  if (input.goalId) {
    const g = await prisma.goal.findFirst({
      where: { id: input.goalId, organisationId: input.organisationId },
    });
    if (!g) throw new Error("Goal not found");
  }
  return prisma.$transaction(async (tx) => {
    const init = await tx.initiative.create({
      data: {
        organisationId: input.organisationId,
        name: input.name,
        description: input.description,
        goalId: input.goalId,
        campaignId: input.campaignId,
        experimentId: input.experimentId,
        missionId: input.missionId,
        status: input.status ?? InitiativeStatus.DRAFT,
      },
    });
    if (init.status === InitiativeStatus.ACTIVE) {
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "INITIATIVE_STARTED",
        aggregateType: "Initiative",
        aggregateId: init.id,
        payload: { initiativeId: init.id, goalId: init.goalId ?? undefined },
      });
    }
    return { id: init.id };
  });
}

export async function linkGoalTarget(input: {
  organisationId: string;
  goalId: string;
  kind: GoalLinkKind;
  targetType: string;
  targetId: string;
  note?: string;
}) {
  const goal = await prisma.goal.findFirst({
    where: { id: input.goalId, organisationId: input.organisationId },
  });
  if (!goal) throw new Error("Goal not found");
  return prisma.goalLink.create({
    data: {
      organisationId: input.organisationId,
      goalId: input.goalId,
      kind: input.kind,
      targetType: input.targetType,
      targetId: input.targetId,
      note: input.note,
    },
  });
}

export async function listKpiHistory(organisationId: string, kpiDefinitionId: string, take = 50) {
  const kpi = await prisma.kpiDefinition.findFirst({
    where: { id: kpiDefinitionId, organisationId },
  });
  if (!kpi) throw new Error("KPI definition not found");
  return prisma.kpiSnapshot.findMany({
    where: { organisationId, kpiDefinitionId },
    orderBy: { observedAt: "desc" },
    take,
  });
}
