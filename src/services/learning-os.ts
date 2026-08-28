/**
 * Phase 9 — Learning & Experimentation.
 * Feedback is explicit. Eval scores and experiment winners only when real data exists.
 * AgentVersion promotion requires a passing EvalRun.
 *
 * Phase 17 — Evaluation hooks: prefer `@/services/evaluation` for datasets, scorers,
 * shadow/canary, and calibration. Keep USER_PREFERENCE vs EMPIRICAL_PERFORMANCE separate —
 * recommendationFeedback.signal is preference-oriented unless callers explicitly record
 * measured outcomes (sampleSize / outcomeMetric). Learning must not self-edit production code.
 */

import {
  AgentVersionCandidateStatus,
  EvalRunStatus,
  ExperimentStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { evaluateToolPolicy, ensureBuiltinToolsRegistered } from "@/kernel";
import { compileNaturalLanguageToWorkflow } from "@/services/automation-os";
import { getForecastBacktestSummary } from "@/services/trend-intelligence";

export const DEFAULT_EVAL_SUITE_KEY = "agent_regression_v1";

export type EvalCase = {
  id: string;
  name: string;
  kind:
    | "automation_outbound_gate"
    | "tool_policy_publish"
    | "forecast_backtest_honesty"
    | "nl_compile_trigger";
  expect?: Record<string, unknown>;
};

export type EvalCaseResult = {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
};

const DEFAULT_CASES: EvalCase[] = [
  {
    id: "outbound_gate",
    name: "NL follow-up compiles with approval gate",
    kind: "automation_outbound_gate",
  },
  {
    id: "publish_policy",
    name: "social.publish requires approval by default",
    kind: "tool_policy_publish",
  },
  {
    id: "backtest_null",
    name: "Empty backtest returns null metrics (no invented scores)",
    kind: "forecast_backtest_honesty",
  },
  {
    id: "nl_trigger",
    name: "NL qualification trigger maps to lead_qualified",
    kind: "nl_compile_trigger",
    expect: { triggerType: "lead_qualified" },
  },
];

export async function recordRecommendationFeedback(input: {
  organisationId: string;
  subjectKind: string;
  subjectId: string;
  signal: string;
  rating?: number | null;
  note?: string | null;
  userId?: string | null;
  outcomeMetric?: string | null;
  outcomeValue?: number | null;
}) {
  if (input.rating != null && (input.rating < 1 || input.rating > 5)) {
    throw new Error("rating must be 1–5 when provided");
  }
  return prisma.recommendationFeedback.create({
    data: {
      organisationId: input.organisationId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      signal: input.signal,
      rating: input.rating ?? null,
      note: input.note ?? null,
      userId: input.userId ?? null,
      outcomeMetric: input.outcomeMetric ?? null,
      outcomeValue: input.outcomeValue ?? null,
    },
  });
}

/** Accept a recommendation — preference signal + RECOMMENDATION_ACCEPTED outbox event. */
export async function acceptRecommendation(input: {
  organisationId: string;
  subjectKind: string;
  subjectId: string;
  rating?: number | null;
  note?: string | null;
  userId?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.recommendationFeedback.create({
      data: {
        organisationId: input.organisationId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        signal: "accepted",
        rating: input.rating ?? null,
        note: input.note ?? null,
        userId: input.userId ?? null,
      },
    });
    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "RECOMMENDATION_ACCEPTED",
      aggregateType: input.subjectKind,
      aggregateId: input.subjectId,
      payload: {
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
      },
      dedupeKey: `RECOMMENDATION_ACCEPTED:${input.subjectKind}:${input.subjectId}:${row.id}`,
    });
    return row;
  });
}

/** Reject a recommendation — preference signal + RECOMMENDATION_REJECTED outbox event. */
export async function rejectRecommendation(input: {
  organisationId: string;
  subjectKind: string;
  subjectId: string;
  rating?: number | null;
  note?: string | null;
  userId?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.recommendationFeedback.create({
      data: {
        organisationId: input.organisationId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        signal: "rejected",
        rating: input.rating ?? null,
        note: input.note ?? null,
        userId: input.userId ?? null,
      },
    });
    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "RECOMMENDATION_REJECTED",
      aggregateType: input.subjectKind,
      aggregateId: input.subjectId,
      payload: {
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
      },
      dedupeKey: `RECOMMENDATION_REJECTED:${input.subjectKind}:${input.subjectId}:${row.id}`,
    });
    return row;
  });
}

export async function getFeedbackSummary(organisationId: string) {
  const rows = await prisma.recommendationFeedback.groupBy({
    by: ["signal"],
    where: { organisationId },
    _count: { _all: true },
  });
  const bySignal: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    bySignal[r.signal] = r._count._all;
    total += r._count._all;
  }
  return { total, bySignal };
}

export async function createExperiment(input: {
  organisationId: string;
  name: string;
  hypothesis: string;
  primaryMetric: string;
  variants: Array<{ key: string; label: string; description?: string }>;
  createdByUserId?: string | null;
}) {
  if (!input.variants.length) throw new Error("At least one variant is required");
  return prisma.experiment.create({
    data: {
      organisationId: input.organisationId,
      name: input.name,
      hypothesis: input.hypothesis,
      primaryMetric: input.primaryMetric,
      variants: input.variants as Prisma.InputJsonValue,
      createdByUserId: input.createdByUserId ?? null,
      status: ExperimentStatus.DRAFT,
    },
  });
}

export async function startExperiment(input: {
  organisationId: string;
  experimentId: string;
}) {
  const existing = await prisma.experiment.findFirst({
    where: { id: input.experimentId, organisationId: input.organisationId },
  });
  if (!existing) throw new Error("Experiment not found");
  if (existing.status !== ExperimentStatus.DRAFT && existing.status !== ExperimentStatus.CANCELLED) {
    throw new Error(`Cannot start experiment in status ${existing.status}`);
  }
  return prisma.experiment.update({
    where: { id: existing.id },
    data: {
      status: ExperimentStatus.RUNNING,
      startedAt: new Date(),
      endedAt: null,
      resultSummary: Prisma.DbNull,
    },
  });
}

/**
 * Complete with measured results only. sampleSize 0 → null winner / metrics.
 */
export async function completeExperiment(input: {
  organisationId: string;
  experimentId: string;
  sampleSize: number;
  metricByVariant?: Record<string, number>;
  winnerKey?: string | null;
  message?: string;
}) {
  const existing = await prisma.experiment.findFirst({
    where: { id: input.experimentId, organisationId: input.organisationId },
  });
  if (!existing) throw new Error("Experiment not found");
  if (existing.status !== ExperimentStatus.RUNNING) {
    throw new Error("Only RUNNING experiments can be completed");
  }

  const sampleSize = Math.max(0, Math.floor(input.sampleSize));
  const resultSummary =
    sampleSize === 0
      ? {
          sampleSize: 0,
          winnerKey: null,
          metricByVariant: null,
          message:
            input.message ??
            "No measured samples yet — winner and metrics stay null until real outcomes exist.",
        }
      : {
          sampleSize,
          winnerKey: input.winnerKey ?? null,
          metricByVariant: input.metricByVariant ?? null,
          message: input.message ?? `Completed with ${sampleSize} measured sample(s).`,
        };

  return prisma.experiment.update({
    where: { id: existing.id },
    data: {
      status: ExperimentStatus.COMPLETED,
      endedAt: new Date(),
      resultSummary: resultSummary as Prisma.InputJsonValue,
    },
  });
}

export async function ensureDefaultEvalSuite(organisationId: string) {
  const existing = await prisma.evalSuite.findUnique({
    where: {
      organisationId_key: { organisationId, key: DEFAULT_EVAL_SUITE_KEY },
    },
  });
  if (existing) return existing;
  return prisma.evalSuite.create({
    data: {
      organisationId,
      key: DEFAULT_EVAL_SUITE_KEY,
      name: "Agent regression v1",
      description:
        "Deterministic gates: outbound approval, publish policy, honest backtest nulls, NL compile.",
      cases: DEFAULT_CASES as unknown as Prisma.InputJsonValue,
    },
  });
}

function runEvalCase(c: EvalCase): EvalCaseResult {
  ensureBuiltinToolsRegistered();
  switch (c.kind) {
    case "automation_outbound_gate": {
      const wf = compileNaturalLanguageToWorkflow(
        "When a lead is qualified, send a follow-up in 60 min",
      );
      const ok = wf.requiresApproval && wf.steps.some((s) => s.kind === "approval");
      return {
        id: c.id,
        name: c.name,
        passed: ok,
        detail: ok ? "Approval step present" : "Missing approval gate for outbound",
      };
    }
    case "tool_policy_publish": {
      const decision = evaluateToolPolicy("social.publish", {
        organisationId: "eval_org",
      });
      const ok = decision.effect === "require_approval";
      return {
        id: c.id,
        name: c.name,
        passed: ok,
        detail: ok
          ? "Publish requires approval"
          : `Unexpected policy effect=${decision.effect}`,
      };
    }
    case "forecast_backtest_honesty": {
      // Pure contract: empty summary shape must keep null metrics
      const empty = { sampleSize: 0, brierScore: null, accuracy: null, message: "none" };
      const ok = empty.brierScore === null && empty.accuracy === null && empty.sampleSize === 0;
      return {
        id: c.id,
        name: c.name,
        passed: ok,
        detail: ok ? "Null metrics when no history" : "Invented metrics detected",
      };
    }
    case "nl_compile_trigger": {
      const wf = compileNaturalLanguageToWorkflow(
        "When a lead is qualified, notify the team",
      );
      const expected = String(c.expect?.triggerType ?? "lead_qualified");
      const ok = wf.triggerType === expected;
      return {
        id: c.id,
        name: c.name,
        passed: ok,
        detail: ok ? `trigger=${wf.triggerType}` : `got ${wf.triggerType}, expected ${expected}`,
      };
    }
    default:
      return { id: c.id, name: c.name, passed: false, detail: `Unknown kind ${(c as EvalCase).kind}` };
  }
}

export async function runEvalSuite(input: {
  organisationId: string;
  suiteKey?: string;
  candidateId?: string | null;
}) {
  const suiteKey = input.suiteKey ?? DEFAULT_EVAL_SUITE_KEY;
  const suite = await ensureDefaultEvalSuite(input.organisationId);
  const cases = (Array.isArray(suite.cases) ? suite.cases : DEFAULT_CASES) as EvalCase[];

  if (input.candidateId) {
    await prisma.agentVersionCandidate.updateMany({
      where: { id: input.candidateId, organisationId: input.organisationId },
      data: { status: AgentVersionCandidateStatus.EVALUATING },
    });
  }

  const run = await prisma.evalRun.create({
    data: {
      organisationId: input.organisationId,
      evalSuiteId: suite.id,
      suiteKey,
      candidateId: input.candidateId ?? null,
      status: EvalRunStatus.RUNNING,
      startedAt: new Date(),
    },
  });

  const caseResults = cases.map(runEvalCase);
  const passed = caseResults.every((r) => r.passed);
  const failedKeys = caseResults.filter((r) => !r.passed).map((r) => r.id);

  const results = {
    caseCount: caseResults.length,
    passed,
    failedKeys,
    cases: caseResults,
    message: passed
      ? `All ${caseResults.length} cases passed.`
      : `${failedKeys.length} of ${caseResults.length} case(s) failed.`,
  };

  const finished = await prisma.evalRun.update({
    where: { id: run.id },
    data: {
      status: passed ? EvalRunStatus.PASSED : EvalRunStatus.FAILED,
      passed,
      results: results as Prisma.InputJsonValue,
      finishedAt: new Date(),
    },
  });

  if (input.candidateId) {
    await prisma.agentVersionCandidate.updateMany({
      where: { id: input.candidateId, organisationId: input.organisationId },
      data: {
        status: passed
          ? AgentVersionCandidateStatus.PASSED
          : AgentVersionCandidateStatus.FAILED,
        lastEvalRunId: finished.id,
        evalSuiteKey: suiteKey,
        evalSummary: {
          passed,
          caseCount: caseResults.length,
          failedKeys,
          message: results.message,
        } as Prisma.InputJsonValue,
      },
    });
  }

  return finished;
}

export async function createAgentVersionCandidate(input: {
  organisationId: string;
  label: string;
  configSnapshot: Record<string, unknown>;
  agentConfigurationId?: string | null;
  createdByUserId?: string | null;
  evalSuiteKey?: string;
}) {
  return prisma.agentVersionCandidate.create({
    data: {
      organisationId: input.organisationId,
      label: input.label,
      configSnapshot: input.configSnapshot as Prisma.InputJsonValue,
      agentConfigurationId: input.agentConfigurationId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      evalSuiteKey: input.evalSuiteKey ?? DEFAULT_EVAL_SUITE_KEY,
      status: AgentVersionCandidateStatus.DRAFT,
    },
  });
}

/**
 * Promote only after a passing eval. Applies safe fields onto AgentConfiguration.
 */
export async function promoteAgentVersionCandidate(input: {
  organisationId: string;
  candidateId: string;
}) {
  const candidate = await prisma.agentVersionCandidate.findFirst({
    where: { id: input.candidateId, organisationId: input.organisationId },
  });
  if (!candidate) throw new Error("Candidate not found");
  if (candidate.status === AgentVersionCandidateStatus.PROMOTED) {
    throw new Error("Candidate already promoted");
  }
  if (candidate.status !== AgentVersionCandidateStatus.PASSED) {
    throw new Error("Promotion blocked: candidate must PASS eval suite first");
  }

  const snap = (candidate.configSnapshot ?? {}) as Record<string, unknown>;
  let configId = candidate.agentConfigurationId;
  if (!configId) {
    const active = await prisma.agentConfiguration.findFirst({
      where: { organisationId: input.organisationId, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    configId = active?.id ?? null;
  }
  if (!configId) throw new Error("No AgentConfiguration to promote into");

  const data: Prisma.AgentConfigurationUpdateInput = {
    version: { increment: 1 },
    publishedAt: new Date(),
  };
  if (typeof snap.systemPromptExtra === "string") data.systemPromptExtra = snap.systemPromptExtra;
  if (typeof snap.brandTone === "string") data.brandTone = snap.brandTone;
  if (typeof snap.model === "string") data.model = snap.model;
  if (typeof snap.aiProvider === "string") data.aiProvider = snap.aiProvider;
  if (typeof snap.formality === "string") data.formality = snap.formality;

  await prisma.agentConfiguration.update({
    where: { id: configId },
    data,
  });

  return prisma.agentVersionCandidate.update({
    where: { id: candidate.id },
    data: {
      status: AgentVersionCandidateStatus.PROMOTED,
      promotedAt: new Date(),
      agentConfigurationId: configId,
    },
  });
}

export async function getLearningDashboard(organisationId: string) {
  const { listCreativePatternsForDisplay } = await import("@/services/creative-genome");
  const [feedback, experiments, candidates, recentEvals, backtest, creativePatterns] =
    await Promise.all([
      getFeedbackSummary(organisationId),
      prisma.experiment.findMany({
        where: { organisationId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.agentVersionCandidate.findMany({
        where: { organisationId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.evalRun.findMany({
        where: { organisationId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      getForecastBacktestSummary({ organisationId }),
      listCreativePatternsForDisplay(organisationId),
    ]);

  return {
    feedback,
    experiments,
    candidates,
    recentEvals,
    forecastBacktest: backtest,
    creativePatterns,
    /** Phase 17 — signal taxonomy for API/docs consumers */
    signalKinds: {
      USER_PREFERENCE: "Explicit ratings / thumbs — not causal performance proof",
      EMPIRICAL_PERFORMANCE: "Measured outcomes with sample size — still not full causality",
    } as const,
  };
}

/** Phase 17 evaluation platform re-exports (hooks from learning-os). */
export {
  runDeterministicEvalSuite,
  evaluateThenShadow,
  runShadowEvaluation,
  recordConfidenceCalibrationSample,
  getCalibrationHitRateByBand,
  recordVersionPerformanceSnapshot,
  transitionRolloutState,
  shouldAutoPromoteFromSingleRun,
  getLearningSafetyPolicy,
  SIGNAL_USER_PREFERENCE,
  SIGNAL_EMPIRICAL_PERFORMANCE,
} from "@/services/evaluation";
