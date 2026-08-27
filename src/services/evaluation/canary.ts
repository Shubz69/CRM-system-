/**
 * Phase 17 — Canary rollout via VersionPerformanceSnapshot.
 * No auto-promote from a single good run.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";
import {
  isRolloutState,
  type RolloutState,
} from "@/services/evaluation/types";
import { assertLearningWriteAllowed } from "@/services/evaluation/learning-safety";

export type VersionArtifactRef = {
  organisationId?: string | null;
  artifactKind: string;
  artifactKey: string;
  version: string;
};

const ALLOWED_TRANSITIONS: Record<RolloutState, readonly RolloutState[]> = {
  CURRENT: ["CANDIDATE", "SHADOW"],
  CANDIDATE: ["SHADOW", "CANARY", "ROLLED_BACK", "CURRENT"],
  /** Observe-only — same role as shadow when callers use CANDIDATE historically. */
  SHADOW: ["CANDIDATE", "CANARY", "ROLLED_BACK"],
  CANARY: ["PROMOTED", "ROLLED_BACK", "CANDIDATE", "SHADOW"],
  PROMOTED: ["CURRENT", "ROLLED_BACK"],
  ROLLED_BACK: ["CANDIDATE", "SHADOW", "CURRENT"],
};

export type PromoteEligibilityConfig = {
  minSampleSize?: number;
  minScore?: number;
  maxRegression?: number;
};

export const DEFAULT_PROMOTE_ELIGIBILITY: Required<PromoteEligibilityConfig> = {
  minSampleSize: 20,
  minScore: 0.7,
  maxRegression: 0.05,
};

export type PromoteEligibilityInput = {
  sampleSize: number;
  /** Aggregate score 0–1 when measured; null/undefined treated as ineligible. */
  score?: number | null;
  /**
   * How much worse than baseline (0 = no regression). Null when unknown → ineligible
   * unless sample/score alone already fail (unknown regression blocks promote).
   */
  regression?: number | null;
  config?: PromoteEligibilityConfig;
};

export type PromoteEligibilityResult = {
  eligible: boolean;
  reasons: string[];
  thresholds: Required<PromoteEligibilityConfig>;
};

/**
 * Hard gates for PROMOTED — never auto-promote from a single good run.
 */
export function shouldPromoteEligibility(
  input: PromoteEligibilityInput,
): PromoteEligibilityResult {
  const thresholds: Required<PromoteEligibilityConfig> = {
    minSampleSize:
      input.config?.minSampleSize ?? DEFAULT_PROMOTE_ELIGIBILITY.minSampleSize,
    minScore: input.config?.minScore ?? DEFAULT_PROMOTE_ELIGIBILITY.minScore,
    maxRegression:
      input.config?.maxRegression ?? DEFAULT_PROMOTE_ELIGIBILITY.maxRegression,
  };
  const reasons: string[] = [];
  const sampleSize = Math.max(0, Math.floor(input.sampleSize));

  if (sampleSize < thresholds.minSampleSize) {
    reasons.push(
      `sampleSize ${sampleSize} < minSampleSize ${thresholds.minSampleSize}`,
    );
  }
  if (input.score == null || !Number.isFinite(input.score)) {
    reasons.push("score missing — cannot promote without measured score");
  } else if (input.score < thresholds.minScore) {
    reasons.push(`score ${input.score} < minScore ${thresholds.minScore}`);
  }
  if (input.regression == null || !Number.isFinite(input.regression)) {
    reasons.push("regression unknown — refuse to assume zero regression");
  } else if (input.regression > thresholds.maxRegression) {
    reasons.push(
      `regression ${input.regression} > maxRegression ${thresholds.maxRegression}`,
    );
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    thresholds,
  };
}

export function assertRolloutTransition(from: RolloutState, to: RolloutState): void {
  if (from === to) return;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid rollout transition ${from} → ${to}`);
  }
}

function readScoreFromMetrics(metrics: unknown): number | null {
  if (!metrics || typeof metrics !== "object") return null;
  const m = metrics as Record<string, unknown>;
  if (typeof m.score === "number" && Number.isFinite(m.score)) return m.score;
  if (typeof m.aggregateScore === "number" && Number.isFinite(m.aggregateScore)) {
    return m.aggregateScore;
  }
  return null;
}

function readRegressionFromMetrics(metrics: unknown): number | null {
  if (!metrics || typeof metrics !== "object") return null;
  const m = metrics as Record<string, unknown>;
  if (typeof m.regression === "number" && Number.isFinite(m.regression)) {
    return m.regression;
  }
  if (typeof m.scoreDelta === "number" && Number.isFinite(m.scoreDelta)) {
    // Negative delta = regression magnitude
    return m.scoreDelta < 0 ? Math.abs(m.scoreDelta) : 0;
  }
  return null;
}

/**
 * Record a performance snapshot. sampleSize 0 → metrics stay empty/null honesty.
 * Does NOT promote — promotion is a separate explicit call.
 * CANDIDATE/SHADOW snapshots may emit LEARNING_UPDATE_PROPOSED when org-scoped.
 */
export async function recordVersionPerformanceSnapshot(input: VersionArtifactRef & {
  rolloutState?: RolloutState;
  metrics?: Record<string, unknown>;
  sampleSize?: number;
  emitProposedEvent?: boolean;
}) {
  assertLearningWriteAllowed("versioned_config");
  const sampleSize = Math.max(0, Math.floor(input.sampleSize ?? 0));
  const rolloutState = input.rolloutState ?? "CANDIDATE";
  if (!isRolloutState(rolloutState)) {
    throw new Error(`Invalid rolloutState: ${rolloutState}`);
  }

  const metrics =
    sampleSize === 0
      ? {
          ...(input.metrics ?? {}),
          note: "No measured samples — metrics not treated as promotion evidence.",
        }
      : (input.metrics ?? {});

  return prisma.$transaction(async (tx) => {
    const row = await tx.versionPerformanceSnapshot.create({
      data: {
        organisationId: input.organisationId ?? null,
        artifactKind: input.artifactKind,
        artifactKey: input.artifactKey,
        version: input.version,
        rolloutState,
        metrics: metrics as Prisma.InputJsonValue,
        sampleSize,
      },
    });

    const propose =
      input.emitProposedEvent !== false &&
      Boolean(input.organisationId) &&
      (rolloutState === "CANDIDATE" || rolloutState === "SHADOW");

    if (propose && input.organisationId) {
      const { appendDomainEvent } = await import("@/services/domain-events/append");
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "LEARNING_UPDATE_PROPOSED",
        aggregateType: input.artifactKind,
        aggregateId: input.artifactKey,
        payload: {
          artifactKind: input.artifactKind,
          artifactKey: input.artifactKey,
          version: input.version,
          sampleSize,
        },
        dedupeKey: `LEARNING_UPDATE_PROPOSED:${input.artifactKind}:${input.artifactKey}:${input.version}:${row.id}`,
      });
    }

    return row;
  });
}

export async function getLatestVersionSnapshot(input: {
  organisationId?: string | null;
  artifactKind: string;
  artifactKey: string;
  version?: string;
}) {
  return prisma.versionPerformanceSnapshot.findFirst({
    where: {
      artifactKind: input.artifactKind,
      artifactKey: input.artifactKey,
      ...(input.version ? { version: input.version } : {}),
      ...(input.organisationId != null
        ? { organisationId: input.organisationId }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Explicit canary advance. Never auto-called from a single eval pass.
 * Transition to PROMOTED requires shouldPromoteEligibility OR throws.
 */
export async function transitionRolloutState(input: VersionArtifactRef & {
  to: RolloutState;
  actorUserId?: string | null;
  reason?: string;
  /** Must be true to enter PROMOTED — blocks accidental one-shot promote */
  confirmPromote?: boolean;
  eligibilityConfig?: PromoteEligibilityConfig;
  /** Override score/regression from latest metrics when provided */
  score?: number | null;
  regression?: number | null;
}) {
  assertLearningWriteAllowed("versioned_config");
  if (!isRolloutState(input.to)) {
    throw new Error(`Invalid target rolloutState: ${input.to}`);
  }

  const latest = await getLatestVersionSnapshot({
    organisationId: input.organisationId,
    artifactKind: input.artifactKind,
    artifactKey: input.artifactKey,
    version: input.version,
  });

  const from = (latest?.rolloutState && isRolloutState(latest.rolloutState)
    ? latest.rolloutState
    : "CANDIDATE") as RolloutState;

  assertRolloutTransition(from, input.to);

  let eligibility: PromoteEligibilityResult | null = null;

  if (input.to === "PROMOTED") {
    if (!input.confirmPromote) {
      throw new Error(
        "Promotion blocked: set confirmPromote=true after canary evidence — never auto-promote from one good run",
      );
    }
    const sampleSize = latest?.sampleSize ?? 0;
    const score =
      input.score !== undefined
        ? input.score
        : readScoreFromMetrics(latest?.metrics);
    const regression =
      input.regression !== undefined
        ? input.regression
        : readRegressionFromMetrics(latest?.metrics);

    eligibility = shouldPromoteEligibility({
      sampleSize,
      score,
      regression,
      config: input.eligibilityConfig,
    });
    if (!eligibility.eligible) {
      throw new Error(
        `Promotion blocked: eligibility failed — ${eligibility.reasons.join("; ")}`,
      );
    }
  }

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.versionPerformanceSnapshot.create({
      data: {
        organisationId: input.organisationId ?? null,
        artifactKind: input.artifactKind,
        artifactKey: input.artifactKey,
        version: input.version,
        rolloutState: input.to,
        sampleSize: latest?.sampleSize ?? 0,
        metrics: {
          previousState: from,
          transitionReason: input.reason ?? null,
          confirmPromote: input.confirmPromote === true,
          eligibility,
          note:
            input.to === "PROMOTED"
              ? "Explicit promotion after eligibility gates — not auto-promoted from a single eval run."
              : input.to === "SHADOW"
                ? "SHADOW observe-only — no production config write."
                : null,
        } as Prisma.InputJsonValue,
      },
    });

    if (input.to === "PROMOTED" && input.organisationId) {
      const { appendDomainEvent } = await import("@/services/domain-events/append");
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "LEARNING_UPDATE_PROMOTED",
        aggregateType: input.artifactKind,
        aggregateId: input.artifactKey,
        payload: {
          artifactKind: input.artifactKind,
          artifactKey: input.artifactKey,
          version: input.version,
          sampleSize: latest?.sampleSize ?? 0,
        },
        dedupeKey: `LEARNING_UPDATE_PROMOTED:${input.artifactKind}:${input.artifactKey}:${input.version}:${created.id}`,
      });
    }

    return created;
  });

  if (input.organisationId && (input.to === "PROMOTED" || input.to === "ROLLED_BACK")) {
    await writeAuditLog({
      organisationId: input.organisationId,
      userId: input.actorUserId,
      action:
        input.to === "PROMOTED"
          ? "evaluation.version.promoted"
          : "evaluation.version.rolled_back",
      entityType: input.artifactKind,
      entityId: input.artifactKey,
      metadata: {
        version: input.version,
        from,
        to: input.to,
        reason: input.reason ?? null,
        eligibility,
      },
    });
  }

  return row;
}

/**
 * Safety helper — a single PASSED shadow/eval run must not promote.
 */
export function shouldAutoPromoteFromSingleRun(_passed: boolean): false {
  return false;
}
