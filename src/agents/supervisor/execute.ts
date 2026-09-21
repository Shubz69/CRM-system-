import { Prisma, type AgentRunStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { asSafePrismaId, updateOrgScopedById } from "@/lib/safe-prisma-id";
import type { AgentExecuteResult } from "@/agents/types";
import { ensureAgentsRegistered, getAgent } from "@/agents";
import { planAgentRun, planAgentRunDeterministic, looksLikeCrmInternal, looksLikeResearch, isQuickResearchAsk } from "@/agents/supervisor/plan";
import type { AgentPlan, PlanStep } from "@/agents/supervisor/types";
import { assertWithinSpendCap, SpendCapExceededError } from "@/services/ai-spend-gate";
import { logger } from "@/lib/logger";
import { retrieveRelevantKnowledge } from "@/services/knowledge";
import {
  formatPreferencesForContext,
  getOrganisationPreferences,
  recordEpisodeFromAgentRun,
  retrieveRelevantEpisodes,
} from "@/services/agent-memory";
import { recordResearchToolCall } from "@/services/research-tool-calls";
import { evaluateToolPolicy } from "@/kernel";
import {
  CUSTOMER_PROGRESS_STAGES,
  attachApprovalProposals,
  computeHintsForAnswerMode,
  customerFacingLabelForAgent,
  resolveAskBusinessContext,
  shapeFinalOutputForMode,
  shouldSuppressBusinessClarification,
} from "@/services/answer-modes";
import { planCompute } from "@/services/compute-governor";
import type { ActionAnswer, DeepAnswer } from "@/services/answer-modes";
import { isProviderLeakingMessage, toCustomerAiError } from "@/lib/customer-ai-errors";
import { customerQualitySummary, scoreResearchQuality } from "@/services/research-quality";
import {
  extractCanonicalGroundedClaims,
  mergeResearchEvidence,
  toScoreResearchClaims,
} from "@/services/research-quality/grounded-claims";
import { stripClarificationMetadata } from "@/lib/agent-request-sanitize";
import { attachVisibleResearchEvidence } from "@/lib/research-visible-evidence";
import { isWebResearchAuthRequiredOutput } from "@/lib/research-job-present";
import { WEB_SEARCH_MISSING_KEY_MESSAGE } from "@/adapters/sources/web";
import {
  isResearchEvidenceAgent,
  isResearchPlanStepName,
  looksLikeResearchOutput,
  remainingWallClockMs,
  researchWallClockCapSeconds,
  shouldSkipOptionalEnrichment,
  raceWithTimeout,
  RESEARCH_QUICK_CEILING_MS,
  RESEARCH_SOURCE_FETCH_MS,
} from "@/agents/supervisor/research-deadline";
import {
  honestEmptyResearchPartial,
  isBlankAskFinalOutput,
  salvageResearchPartialFromDb,
} from "@/agents/supervisor/research-salvage";

export type ExecuteAgentRunResult = {
  runId: string;
  status: AgentRunStatus;
  finalOutput: unknown;
  partialResults: unknown;
  userFacingError: string | null;
};

function asPlan(value: unknown): AgentPlan | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { steps?: PlanStep[]; plainEnglishPlan?: string };
  if (!Array.isArray(v.steps) || typeof v.plainEnglishPlan !== "string") return null;
  return { steps: v.steps, plainEnglishPlan: v.plainEnglishPlan };
}

async function loadLimits(organisationId: string) {
  const row = await prisma.organisationAgentLimits.findUnique({
    where: { organisationId },
  });
  return {
    maxSteps: row?.maxSteps ?? 8,
    maxWallClockSeconds: row?.maxWallClockSeconds ?? 600,
    maxSpendCentsPerRun: row?.maxSpendCentsPerRun ?? null,
  };
}

async function finishRun(input: {
  organisationId: string;
  runId: string;
  status: AgentRunStatus;
  totalCostCents: number;
  finalOutput?: unknown;
  partialResults?: unknown;
  error?: string | null;
  userFacingError?: string | null;
  /** When true, leave finishedAt null (user still needs to act). */
  keepOpen?: boolean;
  /** Used to write episodic memory on terminal outcomes. */
  request?: string;
}): Promise<ExecuteAgentRunResult> {
  const updated = await updateOrgScopedById(prisma.agentRun, {
      id: input.runId,
      organisationId: input.organisationId,
      data: {
      status: input.status,
      finishedAt: input.keepOpen ? null : new Date(),
      totalCostCents: input.totalCostCents,
      finalOutput: (input.finalOutput ?? undefined) as Prisma.InputJsonValue | undefined,
      partialResults: (input.partialResults ?? undefined) as Prisma.InputJsonValue | undefined,
      error: input.error ?? null,
      userFacingError: input.userFacingError ?? null,
    },
  });
  if (updated.count !== 1) {
    throw new Error("Failed to update agent run (org scope mismatch?)");
  }

  if (
    !input.keepOpen &&
    input.request &&
    (input.status === "COMPLETED" || input.status === "PARTIAL")
  ) {
    // Do not block customer-visible completion on episodic memory write.
    void recordEpisodeFromAgentRun({
      organisationId: input.organisationId,
      agentRunId: input.runId,
      request: input.request,
      status: input.status,
      finalOutput: input.finalOutput,
    }).catch((error) => {
      logger.warn("Episodic memory write skipped", {
        runId: input.runId,
        organisationId: input.organisationId,
        message: error instanceof Error ? error.message : "unknown",
      });
    });
  }

  return {
    runId: input.runId,
    status: input.status,
    finalOutput: input.finalOutput ?? null,
    partialResults: input.partialResults ?? null,
    userFacingError: input.userFacingError ?? null,
  };
}

const QUICK_RESEARCH_TIMEOUT = Symbol("quick-research-timeout");

async function shapeResearchPartial(input: {
  organisationId: string;
  runId: string;
  answerMode: import("@prisma/client").AgentAnswerMode | null;
  raw: unknown;
  request: string;
  originalUserPrompt?: string | null;
}): Promise<unknown> {
  return finalizeModeOutput({
    organisationId: input.organisationId,
    agentRunId: input.runId,
    answerMode: input.answerMode,
    raw: input.raw,
    originalUserPrompt: input.originalUserPrompt ?? input.request,
    request: input.request,
  });
}

function researchWallClockUserMessage(input: {
  salvaged: boolean;
  sourceCount: number;
  stepOutputsLength: number;
  stepsToRunLength: number;
}): string {
  if (input.salvaged || input.sourceCount > 0) {
    return "I stopped because this was taking too long. Sources gathered before the limit are below.";
  }
  if (input.stepOutputsLength === 0) {
    return "I stopped because this was taking too long, before sources came back. Try again in a moment.";
  }
  return `I finished ${input.stepOutputsLength} of ${input.stepsToRunLength} steps, then stopped because this was taking too long. Everything completed so far is below.`;
}

function sourceCountFromOutput(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const obj = value as Record<string, unknown>;
  const sources = Array.isArray(obj.sources) ? obj.sources.length : 0;
  const findings = Array.isArray(obj.findings) ? obj.findings.length : 0;
  return sources || findings;
}

/**
 * QUICK/research wall-clock must never persist a blank finalOutput.
 * Salvage org-scoped sources when present; otherwise an honest empty PARTIAL.
 */
async function neverBlankResearchWallClockOutput(input: {
  organisationId: string;
  runId: string;
  request: string;
  answerMode: import("@prisma/client").AgentAnswerMode | null;
  raw: unknown;
  originalUserPrompt?: string | null;
}): Promise<{ output: unknown; salvaged: boolean; sourceCount: number }> {
  let raw = input.raw;
  let salvaged = false;
  if (isBlankAskFinalOutput(raw) || !looksLikeResearchOutput(raw)) {
    const fromDb = await salvageResearchPartialFromDb({
      organisationId: input.organisationId,
      agentRunId: input.runId,
    });
    if (fromDb) {
      raw = fromDb;
      salvaged = true;
    } else {
      raw = honestEmptyResearchPartial(input.request);
    }
  }
  let shaped = await shapeResearchPartial({
    organisationId: input.organisationId,
    runId: input.runId,
    answerMode: input.answerMode ?? "QUICK",
    raw,
    request: input.request,
    originalUserPrompt: input.originalUserPrompt,
  });
  if (isBlankAskFinalOutput(shaped) || shaped == null) {
    shaped = await shapeResearchPartial({
      organisationId: input.organisationId,
      runId: input.runId,
      answerMode: input.answerMode ?? "QUICK",
      raw: salvaged && !isBlankAskFinalOutput(raw) ? raw : honestEmptyResearchPartial(input.request),
      request: input.request,
      originalUserPrompt: input.originalUserPrompt,
    });
  }
  const output =
    isBlankAskFinalOutput(shaped) || shaped == null
      ? honestEmptyResearchPartial(input.request)
      : shaped;
  return {
    output,
    salvaged,
    sourceCount: sourceCountFromOutput(output),
  };
}

/**
 * QUICK web research — skip governor/RAG/CoS/planning LLM. Queue wait and
 * format-clarification time must not consume the FAST search budget.
 */
async function tryQuickResearchFastPath(input: {
  organisationId: string;
  run: {
    id: string;
    request: string;
    answerMode: import("@prisma/client").AgentAnswerMode | null;
    referenceAssetId: string | null;
    status: string;
  };
}): Promise<ExecuteAgentRunResult | null> {
  if (input.run.answerMode !== "QUICK" || input.run.referenceAssetId) return null;
  if (!looksLikeResearch(input.run.request)) return null;

  const executeWallStart = Date.now();
  const planned = planAgentRunDeterministic(input.run.request, {
    organisationId: input.organisationId,
    answerMode: "QUICK",
  });
  if (planned.kind !== "plan") return null;
  const step = planned.plan.steps[0];
  if (!step || step.agentName !== "research" || planned.plan.steps.length !== 1) return null;

  ensureAgentsRegistered();
  const agent = getAgent("research");
  const parsedInput = agent.inputSchema.safeParse(step.input);
  if (!parsedInput.success) return null;

  const claimed = await updateOrgScopedById(prisma.agentRun, {
    id: input.run.id,
    organisationId: input.organisationId,
    extraWhere: { status: { in: ["PENDING", "PLANNING"] } },
    data: {
      status: "RUNNING",
      startedAt: new Date(executeWallStart),
      plan: planned.plan as unknown as Prisma.InputJsonValue,
      plainEnglishPlan: planned.plan.plainEnglishPlan,
      maxWallClockSeconds: researchWallClockCapSeconds("QUICK"),
    },
  });
  if (claimed.count !== 1) return null;

  const stepRow = await prisma.agentStep.create({
    data: {
      organisationId: input.organisationId,
      agentRunId: input.run.id,
      position: 0,
      agentName: "research",
      userFacingLabel: agent.userFacingLabel(parsedInput.data as never) || "Researching sources",
      input: parsedInput.data as Prisma.InputJsonValue,
      status: "RUNNING",
      userFacingStatus: "In progress",
    },
  });

  const deadlineAt = executeWallStart + RESEARCH_QUICK_CEILING_MS;
  const raced = await raceWithTimeout<AgentExecuteResult<unknown> | typeof QUICK_RESEARCH_TIMEOUT>(
    agent.execute(parsedInput.data as never, {
      organisationId: input.organisationId,
      agentRunId: input.run.id,
      agentStepId: stepRow.id,
      knowledgeContext: null,
      deadlineAt,
    }),
    RESEARCH_QUICK_CEILING_MS + 750,
    () => QUICK_RESEARCH_TIMEOUT,
  );

  const latencyTrace = {
    workerPickupAt: executeWallStart,
    queueWaitMs: 0,
    contextLoadMs: 0,
    contextSkipped: 1,
    planMs: 0,
    governorMs: 0,
    preStepContextMs: 0,
    knowledgeContextMs: 0,
    memoryContextMs: 0,
    quickResearchFastPath: 1,
    totalMs: Date.now() - executeWallStart,
  };

  if (raced === QUICK_RESEARCH_TIMEOUT) {
    await updateOrgScopedById(prisma.agentStep, {
      id: stepRow.id,
      organisationId: input.organisationId,
      extraWhere: { agentRunId: { equals: String(asSafePrismaId(input.run.id)) } },
      data: {
        status: "FAILED",
        userFacingStatus: "Stopped — time limit",
        durationMs: Date.now() - executeWallStart,
      },
    });
    const { output, salvaged, sourceCount } = await neverBlankResearchWallClockOutput({
      organisationId: input.organisationId,
      runId: input.run.id,
      request: input.run.request,
      answerMode: "QUICK",
      raw: null,
    });
    logger.warn("Quick research hit wall-clock", {
      runId: input.run.id,
      salvaged: salvaged ? 1 : 0,
      sourceCount,
    });
    return finishRun({
      organisationId: input.organisationId,
      request: input.run.request,
      runId: input.run.id,
      status: "PARTIAL",
      totalCostCents: 0,
      partialResults: { steps: [], latencyTrace },
      finalOutput: output,
      error: "MAX_WALL_CLOCK",
      userFacingError: researchWallClockUserMessage({
        salvaged,
        sourceCount,
        stepOutputsLength: 0,
        stepsToRunLength: 1,
      }),
    });
  }

  const result = raced;
  await updateOrgScopedById(prisma.agentStep, {
    id: stepRow.id,
    organisationId: input.organisationId,
    extraWhere: { agentRunId: { equals: String(asSafePrismaId(input.run.id)) } },
    data: {
      output: result.output as Prisma.InputJsonValue,
      model: result.model ?? null,
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
      costCents: result.costCents ?? 0,
      durationMs: Date.now() - executeWallStart,
      status: "COMPLETED",
      userFacingStatus: "Done",
    },
  });

  const shaped = await shapeResearchPartial({
    organisationId: input.organisationId,
    runId: input.run.id,
    answerMode: "QUICK",
    raw: result.output,
    request: input.run.request,
  });
  logger.info("Ask latency trace", {
    runId: input.run.id,
    answerMode: "QUICK",
    ...latencyTrace,
  });
  const hasEvidence =
    looksLikeResearchOutput(result.output) &&
    ((Array.isArray((result.output as { sources?: unknown }).sources) &&
      ((result.output as { sources: unknown[] }).sources?.length ?? 0) > 0) ||
      (Array.isArray((result.output as { findings?: unknown }).findings) &&
        ((result.output as { findings: unknown[] }).findings?.length ?? 0) > 0));
  const authRequired = !hasEvidence && isWebResearchAuthRequiredOutput(result.output);
  const authMessage =
    authRequired && typeof (result.output as { summary?: string }).summary === "string"
      ? (result.output as { summary: string }).summary
      : WEB_SEARCH_MISSING_KEY_MESSAGE;
  return finishRun({
    organisationId: input.organisationId,
    request: input.run.request,
    runId: input.run.id,
    status: hasEvidence ? "COMPLETED" : authRequired ? "FAILED" : "PARTIAL",
    totalCostCents: result.costCents ?? 0,
    partialResults: {
      steps: [{ agentName: "research", userFacingLabel: "Research", output: result.output }],
      latencyTrace,
    },
    finalOutput: shaped,
    error: hasEvidence ? null : authRequired ? "AUTH_REQUIRED" : "no_sources",
    userFacingError: hasEvidence ? null : authMessage,
  });
}

/**
 * Execute a persisted AgentRun: plan (if needed), then run steps with live
 * AgentStep writes. Never loops. On limit/failure returns PARTIAL + plain English.
 */
export async function executeAgentRun(input: {
  organisationId: string;
  runId: string;
}): Promise<ExecuteAgentRunResult> {
  ensureAgentsRegistered();

  const run = await prisma.agentRun.findFirst({
    where: { id: { equals: String(asSafePrismaId(input.runId)) }, organisationId: { equals: String(asSafePrismaId(input.organisationId)) } },
  });
  if (!run) {
    throw new Error("Agent run not found for organisation");
  }

  if (run.status === "AWAITING_CLARIFICATION" || run.status === "AWAITING_PROMPT_CONFIRM") {
    return {
      runId: run.id,
      status: run.status,
      finalOutput: run.finalOutput,
      partialResults: run.partialResults,
      userFacingError: run.userFacingError,
    };
  }

  if (run.status === "COMPLETED" || run.status === "PARTIAL" || run.status === "FAILED") {
    return {
      runId: run.id,
      status: run.status,
      finalOutput: run.finalOutput,
      partialResults: run.partialResults,
      userFacingError: run.userFacingError,
    };
  }

  // Concurrent execute guard: never reset a run that is already RUNNING or has steps.
  // Preview DEEP paths enqueue a worker and may also reclaim via after() — both must
  // not rewrite PLANNING over an active executor (observed RUNNING → PLANNING → FAILED).
  if (run.status === "RUNNING") {
    return {
      runId: run.id,
      status: run.status,
      finalOutput: run.finalOutput,
      partialResults: run.partialResults,
      userFacingError: run.userFacingError,
    };
  }
  const existingStepCount =
    typeof prisma.agentStep.count === "function"
      ? await prisma.agentStep.count({
          where: { agentRunId: { equals: String(asSafePrismaId(run.id)) }, organisationId: { equals: String(asSafePrismaId(input.organisationId)) } },
        })
      : 0;
  if (existingStepCount > 0) {
    return {
      runId: run.id,
      status: run.status,
      finalOutput: run.finalOutput,
      partialResults: run.partialResults,
      userFacingError: run.userFacingError,
    };
  }

  // Ultra-fast path: QUICK/ACTION internal CRM — deterministic plan + crm_desk only.
  // Avoids governor/RAG/CoS/memory and collapses intermediate run writes.
  if (
    (run.answerMode === "QUICK" || run.answerMode === "ACTION") &&
    looksLikeCrmInternal(run.request) &&
    !run.referenceAssetId
  ) {
    const executeWallStart = Date.now();
    const planned = planAgentRunDeterministic(run.request, {
      organisationId: input.organisationId,
      answerMode: run.answerMode,
    });
    if (
      planned.kind === "plan" &&
      planned.plan.steps.length === 1 &&
      planned.plan.steps[0]?.agentName === "crm_desk"
    ) {
      const step = planned.plan.steps[0]!;
      ensureAgentsRegistered();
      const agent = getAgent("crm_desk");
      const parsedInput = agent.inputSchema.safeParse(step.input);
      if (parsedInput.success) {
        const tTool0 = Date.now();
        const result = await agent.execute(parsedInput.data as never, {
          organisationId: input.organisationId,
          agentRunId: run.id,
          agentStepId: `ultra-crm:${run.id}`,
          knowledgeContext: null,
        });
        const toolMs = Date.now() - tTool0;
        const shaped = shapeFinalOutputForMode(run.answerMode, result.output) ?? result.output;
        const latencyTrace = {
          workerPickupAt: executeWallStart,
          queueWaitMs: 0,
          contextLoadMs: 0,
          contextSkipped: 1,
          planMs: 0,
          governorMs: 0,
          preStepContextMs: 0,
          knowledgeContextMs: 0,
          memoryContextMs: 0,
          crmDeskFastPath: 1,
          toolMs,
          postProcessMs: 0,
          totalMs: Date.now() - executeWallStart,
          ultraFastCrm: 1,
        };
        logger.info("Ask latency trace", {
          runId: run.id,
          answerMode: run.answerMode,
          ...latencyTrace,
        });
        return finishRun({
          organisationId: input.organisationId,
          request: run.request,
          runId: run.id,
          status: "COMPLETED",
          totalCostCents: result.costCents ?? 0,
          partialResults: {
            steps: [{ agentName: "crm_desk", userFacingLabel: "CRM desk", output: result.output }],
            latencyTrace,
          },
          finalOutput: shaped,
        });
      }
    }
  }

  const quickResearch = await tryQuickResearchFastPath({
    organisationId: input.organisationId,
    run,
  });
  if (quickResearch) return quickResearch;

  const org = await prisma.organisation.findFirst({
    where: { id: input.organisationId, deletedAt: null },
    select: { id: true, name: true },
  });

  const limits = await loadLimits(input.organisationId);
  const maxSteps = run.maxSteps || limits.maxSteps;
  let maxWallClockSeconds = run.maxWallClockSeconds || limits.maxWallClockSeconds;
  const maxSpendCents =
    run.maxSpendCents ?? limits.maxSpendCentsPerRun ?? null;
  const isResearchAsk =
    isQuickResearchAsk(run.answerMode, run.request) || looksLikeResearch(run.request);
  if (isResearchAsk) {
    // Stored org/hard caps (often 30s) must not stretch Quick past its FAST ceiling.
    maxWallClockSeconds = Math.min(
      maxWallClockSeconds,
      researchWallClockCapSeconds(run.answerMode),
    );
  }

  const executeWallStart = Date.now();
  const priorPartial =
    run.partialResults && typeof run.partialResults === "object" && !Array.isArray(run.partialResults)
      ? (run.partialResults as Record<string, unknown>)
      : {};
  const priorLatency =
    priorPartial.latencyTrace &&
    typeof priorPartial.latencyTrace === "object" &&
    !Array.isArray(priorPartial.latencyTrace)
      ? (priorPartial.latencyTrace as Record<string, number>)
      : {};
  const latencyTrace: Record<string, number> = {
    ...priorLatency,
    workerPickupAt: executeWallStart,
    queueWaitMs:
      typeof priorLatency.enqueuedAt === "number"
        ? Math.max(0, executeWallStart - priorLatency.enqueuedAt)
        : 0,
  };

  const startedAt = run.startedAt ?? new Date();
  const executeClockStart = new Date(executeWallStart);
  // Queue wait / format-clarification time must not consume the research ceiling.
  const persistStartedAt = isResearchAsk ? executeClockStart : startedAt;
  // CRM Quick/Action and Quick research skip Context Resolver + Business Profile
  // (was ~9s of the wall clock on preview traces, then MAX_WALL_CLOCK with empty steps).
  const skipHeavyBizContext =
    ((run.answerMode === "QUICK" || run.answerMode === "ACTION") &&
      looksLikeCrmInternal(run.request)) ||
    isQuickResearchAsk(run.answerMode, run.request);
  // Claim only PENDING/PLANNING — never overwrite RUNNING (lost race → exit).
  const claimData = {
    status: "PLANNING" as const,
    startedAt: persistStartedAt,
    ...(isResearchAsk ? { maxWallClockSeconds } : {}),
    partialResults: {
      ...priorPartial,
      latencyTrace,
    } as Prisma.InputJsonValue,
    ...(!skipHeavyBizContext || !run.plainEnglishPlan
      ? {
          maxSteps,
          maxWallClockSeconds,
          maxSpendCents,
          plainEnglishPlan: run.plainEnglishPlan || CUSTOMER_PROGRESS_STAGES.understanding,
        }
      : {}),
  };
  const claimed = await updateOrgScopedById(prisma.agentRun, {
    id: run.id,
    organisationId: input.organisationId,
    extraWhere: { status: { in: ["PENDING", "PLANNING"] } },
    data: claimData,
  });
  if (claimed.count !== 1) {
    const cur = await prisma.agentRun.findFirst({
      where: { id: { equals: String(asSafePrismaId(run.id)) }, organisationId: { equals: String(asSafePrismaId(input.organisationId)) } },
    });
    return {
      runId: run.id,
      status: cur?.status ?? run.status,
      finalOutput: cur?.finalOutput ?? run.finalOutput,
      partialResults: cur?.partialResults ?? run.partialResults,
      userFacingError: cur?.userFacingError ?? run.userFacingError,
    };
  }

  // Understanding / business-context stages (customer-facing only).
  // QUICK/ACTION CRM desk answers do not need Context Resolver + full Business Profile
  // (was ~9s of the wall clock on preview traces).
  let businessContextKnownFacts: string[] = [];
  const tBiz0 = Date.now();
  let askCtxCached: Awaited<ReturnType<typeof resolveAskBusinessContext>> | null = null;
  if (!skipHeavyBizContext) {
  try {
    askCtxCached = await resolveAskBusinessContext({
      organisationId: input.organisationId,
      request: run.request,
    });
    businessContextKnownFacts = askCtxCached.knownFacts;
    if (askCtxCached.knownFacts.length && !asPlan(run.plan)) {
      await updateOrgScopedById(prisma.agentRun, {
        id: run.id,
        organisationId: input.organisationId,
        extraWhere: { status: "PLANNING" },
        data: { plainEnglishPlan: CUSTOMER_PROGRESS_STAGES.context },
      });
    }
  } catch (error) {
    logger.warn("Ask business context resolve skipped", {
      runId: run.id,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
  }
  latencyTrace.contextLoadMs = Date.now() - tBiz0;
  latencyTrace.contextSkipped = skipHeavyBizContext ? 1 : 0;

  let plan = asPlan(run.plan);
  const tPlan0 = Date.now();
  if (!plan) {
    const planned = await planAgentRun(run.request, {
      organisationId: input.organisationId,
      organisationName: org?.name,
      referenceAssetId: run.referenceAssetId,
      answerMode: run.answerMode,
    });

    if (planned.kind === "clarification") {
      // Suppress business-info clarifications already answered by Context Resolver.
      let suppress = false;
      try {
        const askCtx =
          askCtxCached ??
          (await resolveAskBusinessContext({
            organisationId: input.organisationId,
            request: run.request,
          }));
        suppress = shouldSuppressBusinessClarification(planned.question, askCtx);
      } catch {
        suppress = false;
      }

      if (!suppress) {
        await updateOrgScopedById(prisma.agentRun, {
      id: run.id,
      organisationId: input.organisationId,
      data: {
            status: "AWAITING_CLARIFICATION",
            clarificationQuestion: planned.question,
            clarificationOptions: planned.options,
            plainEnglishPlan: null,
            plan: Prisma.DbNull,
          },
        });
        return {
          runId: run.id,
          status: "AWAITING_CLARIFICATION",
          finalOutput: null,
          partialResults: null,
          userFacingError: null,
        };
      }
      // Known internally — re-plan without that clarification by treating request as actionable.
      const replanned = await planAgentRun(
        `${run.request}\n\n[Business context already on file]`,
        {
          organisationId: input.organisationId,
          organisationName: org?.name,
          referenceAssetId: run.referenceAssetId,
          answerMode: run.answerMode ?? "EXECUTIVE",
        },
      );
      if (replanned.kind === "clarification") {
        await updateOrgScopedById(prisma.agentRun, {
      id: run.id,
      organisationId: input.organisationId,
      data: {
            status: "AWAITING_CLARIFICATION",
            clarificationQuestion: replanned.question,
            clarificationOptions: replanned.options,
            plainEnglishPlan: null,
            plan: Prisma.DbNull,
          },
        });
        return {
          runId: run.id,
          status: "AWAITING_CLARIFICATION",
          finalOutput: null,
          partialResults: null,
          userFacingError: null,
        };
      }
      plan = replanned.plan;
    } else {
      plan = planned.plan;
    }

    await updateOrgScopedById(prisma.agentRun, {
      id: run.id,
      organisationId: input.organisationId,
      data: {
        plan: plan as unknown as Prisma.InputJsonValue,
        plainEnglishPlan: plan.plainEnglishPlan,
        clarificationQuestion: null,
        clarificationOptions: Prisma.DbNull,
        status: "RUNNING",
      },
    });
  } else {
    await updateOrgScopedById(prisma.agentRun, {
      id: run.id,
      organisationId: input.organisationId,
      data: {
        status: "RUNNING",
        plainEnglishPlan: plan.plainEnglishPlan,
      },
    });
  }
  latencyTrace.planMs = Date.now() - tPlan0;

  const provisionalSteps = plan.steps;
  const crmDeskOnlyEarly =
    provisionalSteps.length === 1 && provisionalSteps.every((s) => s.agentName === "crm_desk");
  const skipGovernor =
    crmDeskOnlyEarly ||
    (run.answerMode === "QUICK" && looksLikeResearch(run.request));

  // Map answer mode into Compute Governor (single pipeline) and apply budgets.
  // Skip governor DB round-trip for pure CRM desk Quick/Action — budgets already fixed.
  let governedMaxSteps = maxSteps;
  let governedContextChars: number | null = null;
  const tGov0 = Date.now();
  if (run.answerMode && !skipGovernor) {
    try {
      const hints = computeHintsForAnswerMode(run.answerMode);
      const computePlan = await planCompute({
        organisationId: input.organisationId,
        taskType: "insight_generation",
        ...hints,
        evidenceState: {
          hasBusinessState: businessContextKnownFacts.length > 0,
        },
      });
      // Governor budgets always influence execution (even when model selection is shadow).
      governedMaxSteps = Math.min(maxSteps, Math.max(1, computePlan.toolBudget));
      governedContextChars = Math.min(12_000, Math.max(500, computePlan.contextBudget * 2));
      logger.info("Compute governor applied answer-mode plan", {
        runId: run.id,
        answerMode: run.answerMode,
        governorMode: computePlan.governorMode,
        activeMode: computePlan.activeMode,
        toolBudget: computePlan.toolBudget,
        verificationDepth: computePlan.verificationDepth,
        estimatedCostCents: computePlan.estimatedCostCents,
        shadowOnly: computePlan.shadowOnly,
      });
    } catch (error) {
      logger.warn("Compute governor plan for answer mode skipped", {
        runId: run.id,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  } else if (run.answerMode === "QUICK" || run.answerMode === "ACTION") {
    governedMaxSteps = Math.min(maxSteps, 1);
  }
  latencyTrace.governorMs = Date.now() - tGov0;

  const stepsToRun = plan.steps.slice(0, governedMaxSteps);
  let wallClockStartedAt = startedAt;
  if (stepsToRun.some((s) => isResearchPlanStepName(s.agentName))) {
    // Queue wait / format-clarification time must not consume the research ceiling.
    wallClockStartedAt = executeClockStart;
    maxWallClockSeconds = Math.min(
      maxWallClockSeconds,
      researchWallClockCapSeconds(run.answerMode),
    );
    latencyTrace.researchCeilingSec = maxWallClockSeconds;
    latencyTrace.queueExcludedFromWallClock = 1;
  }
  const stepOutputs: Array<{ agentName: string; userFacingLabel: string; output: unknown }> =
    [];
  let totalCostCents = run.totalCostCents || 0;
  let previousOutput: unknown = null;

  // Pure CRM desk answers already load org state inside crm_desk — skip duplicate
  // RAG / episodic / CoS assembly that dominated Quick latency on the internal path.
  const crmDeskOnly =
    stepsToRun.length === 1 && stepsToRun.every((s) => s.agentName === "crm_desk");
  const quickResearchOnly =
    stepsToRun.length === 1 &&
    stepsToRun[0]?.agentName === "research" &&
    run.answerMode === "QUICK";

  // Phase 2: organisational knowledge as working memory for this mission (never invents facts).
  let knowledgeContext: string | null = null;
  let knowledgeDocumentTitles: string[] = [];
  let knowledgeRetrievalMode: "hybrid" | "lexical" | "none" = "none";
  let pendingKnowledgeTool: {
    durationMs: number;
    documentTitles: string[];
    mode: string;
    chunkCount: number;
  } | null = null;
  let pendingMemoryTool: {
    durationMs: number;
    episodeCount: number;
    episodeIds: string[];
  } | null = null;
  let episodicContext: string | null = null;

  const tCtx0 = Date.now();
  if (!crmDeskOnly && !quickResearchOnly) {
  const knowledgePolicy = evaluateToolPolicy("knowledge.retrieve", {
    organisationId: input.organisationId,
  });
  if (knowledgePolicy.effect !== "deny") {
    try {
      const startedKnowledge = Date.now();
      const retrieved = await retrieveRelevantKnowledge({
        organisationId: input.organisationId,
        query: run.request,
        limit: 6,
      });
      knowledgeDocumentTitles = retrieved.documentTitles;
      knowledgeRetrievalMode = retrieved.mode;
      if (retrieved.chunks.length > 0) {
        knowledgeContext = [
          "Organisation knowledge (approved internal docs — not external citations):",
          ...retrieved.chunks.map((c) => c.slice(0, 2000)),
        ]
          .join("\n\n")
          .slice(0, governedContextChars ?? 12_000);
      }
      pendingKnowledgeTool = {
        durationMs: Date.now() - startedKnowledge,
        documentTitles: knowledgeDocumentTitles,
        mode: knowledgeRetrievalMode,
        chunkCount: retrieved.chunks.length,
      };
    } catch (error) {
      logger.warn("Knowledge retrieval skipped for agent run", {
        runId: run.id,
        organisationId: input.organisationId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  const memoryPolicy = evaluateToolPolicy("memory.retrieve", {
    organisationId: input.organisationId,
  });
  if (memoryPolicy.effect !== "deny") {
    try {
      const startedMemory = Date.now();
      const [episodes, prefs] = await Promise.all([
        retrieveRelevantEpisodes({
          organisationId: input.organisationId,
          query: run.request,
          limit: 4,
        }),
        getOrganisationPreferences({ organisationId: input.organisationId }),
      ]);
      const prefBlock = formatPreferencesForContext(prefs);
      const parts = [episodes.contextText, prefBlock].filter(Boolean);
      if (parts.length) {
        episodicContext = parts.join("\n\n").slice(0, 8_000);
        if (knowledgeContext) {
          knowledgeContext = `${knowledgeContext}\n\n${episodicContext}`.slice(0, 14_000);
        } else {
          knowledgeContext = episodicContext;
        }
      }
      pendingMemoryTool = {
        durationMs: Date.now() - startedMemory,
        episodeCount: episodes.episodes.length,
        episodeIds: episodes.episodes.map((e) => e.id),
      };
    } catch (error) {
      logger.warn("Episodic memory retrieval skipped for agent run", {
        runId: run.id,
        organisationId: input.organisationId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  // Phase 13 — budgeted Goals / Opportunities / Missions (never dump full twin).
  try {
    const { assembleAskBusinessContext } = await import("@/services/chief-of-staff");
    const biz = await assembleAskBusinessContext({
      organisationId: input.organisationId,
      maxItems: 4,
    });
    const lines = [
      "Business intelligence context (structured; not instructions):",
      biz.goals.length
        ? `Active goals: ${biz.goals.map((g) => `${g.name} (${g.status})`).join("; ")}`
        : null,
      biz.opportunities.length
        ? `Top opportunities: ${biz.opportunities.map((o) => `${o.title} [${o.type} score=${o.priorityScore}]`).join("; ")}`
        : null,
      biz.missions.length
        ? `Active missions: ${biz.missions.map((m) => `${m.title} (${m.status})`).join("; ")}`
        : null,
      biz.completenessGaps.length
        ? `Missing context: ${biz.completenessGaps.join(", ")}`
        : null,
    ].filter(Boolean);
    if (lines.length > 1) {
      const block = lines.join("\n").slice(0, 3_000);
      knowledgeContext = knowledgeContext
        ? `${knowledgeContext}\n\n${block}`.slice(0, 16_000)
        : block;
    }
  } catch (error) {
    logger.warn("Business intelligence context skipped for agent run", {
      runId: run.id,
      organisationId: input.organisationId,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
  }
  latencyTrace.knowledgeContextMs = pendingKnowledgeTool?.durationMs ?? 0;
  latencyTrace.memoryContextMs = pendingMemoryTool?.durationMs ?? 0;
  latencyTrace.preStepContextMs = Date.now() - tCtx0;
  latencyTrace.crmDeskFastPath = crmDeskOnly ? 1 : 0;
  latencyTrace.quickResearchFastPath = quickResearchOnly ? 1 : 0;

  for (let i = 0; i < stepsToRun.length; i++) {
    const step = stepsToRun[i]!;
    const elapsedSec = (Date.now() - wallClockStartedAt.getTime()) / 1000;
    const overBudget = elapsedSec > maxWallClockSeconds;
    const lastDitchResearch =
      overBudget &&
      i === 0 &&
      stepOutputs.length === 0 &&
      (isResearchPlanStepName(step.agentName) || isResearchAsk);
    if (overBudget && !lastDitchResearch) {
      const originalUserPrompt = readOriginalUserPrompt(run);
      const treatAsResearch =
        isResearchAsk ||
        looksLikeResearchOutput(previousOutput) ||
        stepsToRun.some((s) => isResearchPlanStepName(s.agentName));
      if (treatAsResearch) {
        const { output, salvaged, sourceCount } = await neverBlankResearchWallClockOutput({
          organisationId: input.organisationId,
          runId: run.id,
          request: run.request,
          answerMode: run.answerMode,
          raw: previousOutput,
          originalUserPrompt,
        });
        const withPhase =
          looksLikeResearchOutput(output) &&
          output &&
          typeof output === "object" &&
          (output as { researchQuality?: unknown }).researchQuality != null
            ? {
                ...(output as Record<string, unknown>),
                phase: "PARTIAL_WITH_GROUNDED_QUALITY",
              }
            : output;
        return finishRun({
          organisationId: input.organisationId,
          request: run.request,
          runId: run.id,
          status: "PARTIAL",
          totalCostCents,
          partialResults: { steps: stepOutputs },
          finalOutput: withPhase,
          error: "MAX_WALL_CLOCK",
          userFacingError: researchWallClockUserMessage({
            salvaged,
            sourceCount,
            stepOutputsLength: stepOutputs.length,
            stepsToRunLength: stepsToRun.length,
          }),
        });
      }
      return finishRun({
        organisationId: input.organisationId,
        request: run.request,
        runId: run.id,
        status: "PARTIAL",
        totalCostCents,
        partialResults: { steps: stepOutputs },
        finalOutput: previousOutput,
        error: "MAX_WALL_CLOCK",
        userFacingError: `I finished ${stepOutputs.length} of ${stepsToRun.length} steps, then stopped because this was taking too long. Everything completed so far is below.`,
      });
    }

    if (maxSpendCents != null && totalCostCents >= maxSpendCents) {
      const originalUserPrompt = readOriginalUserPrompt(run);
      const shapedPartial = looksLikeResearchOutput(previousOutput)
        ? await finalizeModeOutput({
            organisationId: input.organisationId,
            agentRunId: run.id,
            answerMode: run.answerMode,
            raw: previousOutput,
            originalUserPrompt,
            request: run.request,
          })
        : previousOutput;
      return finishRun({
        organisationId: input.organisationId,
        request: run.request,
        runId: run.id,
        status: "PARTIAL",
        totalCostCents,
        partialResults: { steps: stepOutputs },
        finalOutput: shapedPartial,
        error: "MAX_SPEND_PER_RUN",
        userFacingError: `I finished ${stepOutputs.length} of ${stepsToRun.length} steps, then paused to stay within your spend limit for this run. You can raise the limit in settings if you want longer runs.`,
      });
    }

    // Optional analyst/critic must not starve mandatory RQS after grounded evidence.
    const remainingMs = remainingWallClockMs({
      startedAt: wallClockStartedAt,
      maxWallClockSeconds,
    });
    if (
      looksLikeResearchOutput(previousOutput) &&
      shouldSkipOptionalEnrichment({
        agentName: step.agentName,
        remainingMs,
      })
    ) {
      for (let j = i; j < stepsToRun.length; j++) {
        const pending = stepsToRun[j]!;
        let pendingLabel = "Next step";
        try {
          const pendingAgent = getAgent(pending.agentName);
          pendingLabel =
            pendingAgent.userFacingLabel(pending.input as never) || pendingLabel;
        } catch {
          /* ignore */
        }
        await prisma.agentStep.create({
          data: {
            organisationId: input.organisationId,
            agentRunId: run.id,
            position: j,
            agentName: pending.agentName,
            userFacingLabel: pendingLabel,
            input: pending.input as Prisma.InputJsonValue,
            status: "SKIPPED",
            userFacingStatus: "Skipped — not enough time left for optional enrichment",
          },
        });
      }

      const originalUserPrompt = readOriginalUserPrompt(run);
      const shapedFinal = await finalizeModeOutput({
        organisationId: input.organisationId,
        agentRunId: run.id,
        answerMode: run.answerMode,
        raw:
          previousOutput && typeof previousOutput === "object"
            ? {
                ...(previousOutput as Record<string, unknown>),
                analystEnrichmentSkipped: true,
                phase: "GROUNDED_QUALITY_BEFORE_OPTIONAL_ENRICHMENT",
              }
            : previousOutput,
        originalUserPrompt,
        request: run.request,
      });
      return finishRun({
        organisationId: input.organisationId,
        request: run.request,
        runId: run.id,
        status: "COMPLETED",
        totalCostCents,
        finalOutput: shapedFinal,
        partialResults: { steps: stepOutputs },
      });
    }

    let agent;
    try {
      agent = getAgent(step.agentName);
    } catch {
      return finishRun({
        organisationId: input.organisationId,
        request: run.request,
        runId: run.id,
        status: stepOutputs.length ? "PARTIAL" : "FAILED",
        totalCostCents,
        partialResults: stepOutputs.length ? { steps: stepOutputs } : null,
        finalOutput: previousOutput,
        error: `UNKNOWN_AGENT:${step.agentName}`,
        userFacingError: stepOutputs.length
          ? `I completed ${stepOutputs.length} step(s), but the next step wasn't available. Here's what I have so far.`
          : "I couldn't start that request because a needed step wasn't available. Try rephrasing what you need.",
      });
    }

    // Forward prior output when the next step expects text / researchJobId.
    const rawInput = { ...step.input } as Record<string, unknown>;
    if (previousOutput && typeof previousOutput === "object" && previousOutput !== null) {
      const prev = previousOutput as Record<string, unknown>;
      if (typeof rawInput.text !== "string") {
        if (typeof prev.summary === "string") rawInput.text = prev.summary;
        else if (typeof prev.echo === "string") rawInput.text = prev.echo;
      }
      if (typeof rawInput.researchJobId !== "string" && typeof prev.researchJobId === "string") {
        rawInput.researchJobId = prev.researchJobId;
      }
      if (!rawInput.claims && Array.isArray(prev.claims)) {
        rawInput.claims = prev.claims;
      }
      if (!rawInput.contradictions && Array.isArray(prev.contradictions)) {
        rawInput.contradictions = prev.contradictions;
      }
      if (!rawInput.gaps && Array.isArray(prev.gaps)) {
        rawInput.gaps = prev.gaps;
      }
      if (typeof rawInput.summary !== "string" && typeof prev.summary === "string") {
        rawInput.summary = prev.summary;
      }
      if (typeof rawInput.topic !== "string" && typeof prev.topic === "string") {
        rawInput.topic = prev.topic;
      }
      if (typeof rawInput.referenceAssetId !== "string" && typeof prev.referenceAssetId === "string") {
        rawInput.referenceAssetId = prev.referenceAssetId;
      }
      if (typeof rawInput.prompt !== "string" && typeof prev.proposedPrompt === "string") {
        rawInput.prompt = prev.proposedPrompt;
      }
    }

    const parsedInput = agent.inputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      return finishRun({
        organisationId: input.organisationId,
        request: run.request,
        runId: run.id,
        status: stepOutputs.length ? "PARTIAL" : "FAILED",
        totalCostCents,
        partialResults: stepOutputs.length ? { steps: stepOutputs } : null,
        finalOutput: previousOutput,
        error: "INVALID_STEP_INPUT",
        userFacingError: stepOutputs.length
          ? `I completed ${stepOutputs.length} step(s), but couldn't prepare the next one. Here's what I finished.`
          : "I couldn't understand the details for that request. Try again with a clearer description.",
      });
    }

    const agentLabel = agent.userFacingLabel(parsedInput.data as never);
    if (!agentLabel || !agentLabel.trim()) {
      return finishRun({
        organisationId: input.organisationId,
        request: run.request,
        runId: run.id,
        status: "FAILED",
        totalCostCents,
        error: "EMPTY_USER_FACING_LABEL",
        userFacingError:
          "Something went wrong preparing progress updates. Please try again — no charge was made for this step.",
      });
    }

    const progressLabel =
      customerFacingLabelForAgent(agent.name) || agentLabel.trim();

    const estimate = agent.estimateCostCents(parsedInput.data as never);
    try {
      await assertWithinSpendCap(input.organisationId, estimate);
    } catch (error) {
      if (error instanceof SpendCapExceededError) {
        return finishRun({
          organisationId: input.organisationId,
          request: run.request,
          runId: run.id,
          status: stepOutputs.length ? "PARTIAL" : "FAILED",
          totalCostCents,
          partialResults: stepOutputs.length ? { steps: stepOutputs } : null,
          finalOutput: previousOutput,
          error: "SPEND_CAP",
          userFacingError: stepOutputs.length
            ? `I finished ${stepOutputs.length} step(s), then paused because you've used this month's AI allowance. Here's what I completed.`
            : "You've used this month's AI allowance, so I didn't start this run. Your allowance resets next month, or an admin can raise it.",
        });
      }
      throw error;
    }

    if (maxSpendCents != null && totalCostCents + estimate > maxSpendCents) {
      return finishRun({
        organisationId: input.organisationId,
        request: run.request,
        runId: run.id,
        status: stepOutputs.length ? "PARTIAL" : "FAILED",
        totalCostCents,
        partialResults: stepOutputs.length ? { steps: stepOutputs } : null,
        finalOutput: previousOutput,
        error: "MAX_SPEND_PER_RUN",
        userFacingError: stepOutputs.length
          ? `I finished ${stepOutputs.length} of ${stepsToRun.length} steps, then paused to stay within your spend limit for this run.`
          : "This run would go over your per-run spend limit, so I didn't start it.",
      });
    }

    // Write step AS EXECUTION PROGRESSES (not batched at end).
    const stepRow = await prisma.agentStep.create({
      data: {
        organisationId: input.organisationId,
        agentRunId: run.id,
        position: i,
        agentName: agent.name,
        userFacingLabel: progressLabel,
        input: parsedInput.data as Prisma.InputJsonValue,
        status: "RUNNING",
        userFacingStatus: "In progress",
      },
    });

    const stepStarted = Date.now();
    try {
      if (i === 0 && pendingKnowledgeTool) {
        await recordResearchToolCall({
          organisationId: input.organisationId,
          agentStepId: stepRow.id,
          toolName: "knowledge.retrieve",
          args: { query: run.request.slice(0, 500), limit: 6 },
          result: {
            documentTitles: pendingKnowledgeTool.documentTitles,
            mode: pendingKnowledgeTool.mode,
            chunkCount: pendingKnowledgeTool.chunkCount,
          },
          durationMs: pendingKnowledgeTool.durationMs,
        });
        pendingKnowledgeTool = null;
      }

      if (i === 0 && pendingMemoryTool) {
        await recordResearchToolCall({
          organisationId: input.organisationId,
          agentStepId: stepRow.id,
          toolName: "memory.retrieve",
          args: { query: run.request.slice(0, 500), limit: 4 },
          result: {
            episodeCount: pendingMemoryTool.episodeCount,
            episodeIds: pendingMemoryTool.episodeIds,
          },
          durationMs: pendingMemoryTool.durationMs,
        });
        pendingMemoryTool = null;
      }

      const stepDeadlineAt = lastDitchResearch
        ? Date.now() + RESEARCH_SOURCE_FETCH_MS.FAST + 1_500
        : wallClockStartedAt.getTime() + maxWallClockSeconds * 1000;
      const executePromise = agent.execute(parsedInput.data as never, {
        organisationId: input.organisationId,
        agentRunId: run.id,
        agentStepId: stepRow.id,
        knowledgeContext,
        knowledgeDocumentTitles,
        knowledgeRetrievalMode,
        episodicContext,
        deadlineAt: stepDeadlineAt,
      });
      const raced = isResearchPlanStepName(agent.name)
        ? await raceWithTimeout<AgentExecuteResult<unknown> | typeof QUICK_RESEARCH_TIMEOUT>(
            executePromise,
            Math.max(400, stepDeadlineAt - Date.now() + 500),
            () => QUICK_RESEARCH_TIMEOUT,
          )
        : await executePromise;
      if (raced === QUICK_RESEARCH_TIMEOUT) {
        const durationMs = Date.now() - stepStarted;
        await updateOrgScopedById(prisma.agentStep, {
          id: stepRow.id,
          organisationId: input.organisationId,
          extraWhere: { agentRunId: { equals: String(asSafePrismaId(run.id)) } },
          data: {
            durationMs,
            status: "FAILED",
            userFacingStatus: "Stopped — time limit",
          },
        });
        const originalUserPrompt = readOriginalUserPrompt(run);
        const { output, salvaged, sourceCount } = await neverBlankResearchWallClockOutput({
          organisationId: input.organisationId,
          runId: run.id,
          request: run.request,
          answerMode: run.answerMode,
          raw: previousOutput,
          originalUserPrompt,
        });
        return finishRun({
          organisationId: input.organisationId,
          request: run.request,
          runId: run.id,
          status: "PARTIAL",
          totalCostCents,
          partialResults: { steps: stepOutputs },
          finalOutput: output,
          error: "MAX_WALL_CLOCK",
          userFacingError: researchWallClockUserMessage({
            salvaged,
            sourceCount,
            stepOutputsLength: stepOutputs.length,
            stepsToRunLength: stepsToRun.length,
          }),
        });
      }
      const result = raced;

      const durationMs = Date.now() - stepStarted;
      const costCents = result.costCents ?? 0;
      totalCostCents += costCents;

      await updateOrgScopedById(prisma.agentStep, {
        id: stepRow.id,
        organisationId: input.organisationId,
        extraWhere: { agentRunId: { equals: String(asSafePrismaId(run.id)) } },
        data: {
          output: result.output as Prisma.InputJsonValue,
          model: result.model ?? null,
          tokensIn: result.tokensIn ?? null,
          tokensOut: result.tokensOut ?? null,
          costCents,
          durationMs,
          status: "COMPLETED",
          userFacingStatus: "Done",
        },
      });

      await updateOrgScopedById(prisma.agentRun, {
      id: run.id,
      organisationId: input.organisationId,
      data: { totalCostCents },
      });

      const priorForMerge = previousOutput;
      previousOutput = result.output;
      // Critic is a verification step — never let its short status wipe the analyst brief.
      if (
        agent.name === "critic" &&
        priorForMerge &&
        typeof priorForMerge === "object" &&
        priorForMerge !== null
      ) {
        const prior = priorForMerge as Record<string, unknown>;
        const criticOut = result.output as Record<string, unknown>;
        const priorSummary =
          typeof prior.summary === "string" && prior.summary.trim() ? prior.summary.trim() : null;
        const criticSummary =
          typeof criticOut.summary === "string" ? criticOut.summary : null;
        previousOutput = {
          researchJobId:
            (typeof criticOut.researchJobId === "string" && criticOut.researchJobId) ||
            (typeof prior.researchJobId === "string" && prior.researchJobId) ||
            undefined,
          shortAnswer: typeof prior.shortAnswer === "string" ? prior.shortAnswer : undefined,
          summary: priorSummary || criticSummary || "",
          brief: typeof prior.brief === "string" ? prior.brief : undefined,
          claims: Array.isArray(prior.claims) ? prior.claims : [],
          viralExamples: Array.isArray(prior.viralExamples) ? prior.viralExamples : [],
          nextBigThings: Array.isArray(prior.nextBigThings) ? prior.nextBigThings : [],
          contentHooks: Array.isArray(prior.contentHooks) ? prior.contentHooks : [],
          algorithmNotes: Array.isArray(prior.algorithmNotes) ? prior.algorithmNotes : [],
          contradictions: Array.isArray(prior.contradictions) ? prior.contradictions : [],
          gaps: Array.isArray(prior.gaps) ? prior.gaps : [],
          findings: Array.isArray(prior.findings) ? prior.findings : undefined,
          sources: Array.isArray(prior.sources) ? prior.sources : undefined,
          researchQuality: prior.researchQuality,
          researchQualitySummary: prior.researchQualitySummary,
          groundedClaimCount: prior.groundedClaimCount,
          analystEnrichmentFailed: prior.analystEnrichmentFailed,
          analystEnrichmentSkipped: prior.analystEnrichmentSkipped,
          verification: criticOut,
        };
      }

      // Mandatory: attach RQS as soon as grounded research evidence exists,
      // before optional analyst/critic can consume remaining wall-clock.
      if (
        isResearchEvidenceAgent(agent.name) ||
        looksLikeResearchOutput(previousOutput)
      ) {
        const originalUserPrompt = readOriginalUserPrompt(run);
        previousOutput = attachResearchQualityIfApplicable({
          organisationId: input.organisationId,
          answerMode: run.answerMode,
          originalUserPrompt,
          request: run.request,
          output: previousOutput,
        });
      }

      stepOutputs.push({
        agentName: agent.name,
        userFacingLabel: progressLabel,
        output: result.output,
      });

      if (
        result.output &&
        typeof result.output === "object" &&
        (result.output as { awaitPromptConfirm?: unknown }).awaitPromptConfirm === true
      ) {
        const out = result.output as {
          proposedPrompt?: string;
          estimatedCostCents?: number;
          summary?: string;
        };
        if (!out.proposedPrompt?.trim()) {
          return finishRun({
            organisationId: input.organisationId,
            request: run.request,
            runId: run.id,
            status: "FAILED",
            totalCostCents,
            partialResults: { steps: stepOutputs },
            finalOutput: result.output,
            error: "IMAGE_SAFETY_OR_EMPTY_PROMPT",
            userFacingError:
              out.summary ||
              "I couldn't safely turn that reference into a generation prompt. Try a different image or description.",
          });
        }
        return finishRun({
          organisationId: input.organisationId,
          request: run.request,
          runId: run.id,
          status: "AWAITING_PROMPT_CONFIRM",
          totalCostCents,
          partialResults: { steps: stepOutputs },
          finalOutput: result.output,
          keepOpen: true,
        });
      }
    } catch (error) {
      const durationMs = Date.now() - stepStarted;
      const message = error instanceof Error ? error.message : "Step failed";
      const userFacing =
        error &&
        typeof error === "object" &&
        "userFacingMessage" in error &&
        typeof (error as { userFacingMessage: unknown }).userFacingMessage === "string"
          ? `${(error as { userFacingMessage: string }).userFacingMessage}${
              "alternativeSuggestion" in error &&
              typeof (error as { alternativeSuggestion: unknown }).alternativeSuggestion ===
                "string"
                ? ` ${(error as { alternativeSuggestion: string }).alternativeSuggestion}`
                : ""
            }`
          : null;
      logger.warn("Agent step failed", {
        runId: run.id,
        organisationId: input.organisationId,
        agentName: agent.name,
        message,
      });

      await updateOrgScopedById(prisma.agentStep, {
        id: stepRow.id,
        organisationId: input.organisationId,
        extraWhere: { agentRunId: { equals: String(asSafePrismaId(run.id)) } },
        data: {
          durationMs,
          status: "FAILED",
          userFacingStatus: "Couldn't finish",
        },
      });

      // Mark remaining planned steps as skipped (no silent failure).
      for (let j = i + 1; j < stepsToRun.length; j++) {
        const pending = stepsToRun[j]!;
        let pendingLabel = "Next step";
        try {
          const pendingAgent = getAgent(pending.agentName);
          pendingLabel = pendingAgent.userFacingLabel(pending.input as never) || pendingLabel;
        } catch {
          /* ignore */
        }
        await prisma.agentStep.create({
          data: {
            organisationId: input.organisationId,
            agentRunId: run.id,
            position: j,
            agentName: pending.agentName,
            userFacingLabel: pendingLabel,
            input: pending.input as Prisma.InputJsonValue,
            status: "SKIPPED",
            userFacingStatus: "Skipped — previous step didn't finish",
          },
        });
      }

      return finishRun({
        organisationId: input.organisationId,
        request: run.request,
        runId: run.id,
        status: stepOutputs.length ? "PARTIAL" : "FAILED",
        totalCostCents,
        partialResults: stepOutputs.length ? { steps: stepOutputs } : null,
        finalOutput: previousOutput,
        error: message,
        userFacingError:
          (userFacing && !isProviderLeakingMessage(userFacing)
            ? userFacing
            : userFacing
              ? toCustomerAiError(userFacing)
              : null) ||
          (stepOutputs.length
            ? `I completed ${stepOutputs.length} of ${stepsToRun.length} steps, then ran into a problem and stopped. Here's what I finished before that.`
            : isProviderLeakingMessage(message)
              ? toCustomerAiError(error)
              : "I couldn't finish that request. Nothing useful was produced — try again in a moment, or rephrase what you need."),
      });
    }
  }

  // Truncated by maxSteps / governor tool budget
  if (plan.steps.length > governedMaxSteps) {
    const originalUserPrompt = readOriginalUserPrompt(run);
    const shapedPartial = await finalizeModeOutput({
      organisationId: input.organisationId,
      agentRunId: run.id,
      answerMode: run.answerMode,
      raw: previousOutput,
      originalUserPrompt,
      request: run.request,
    });
    return finishRun({
      organisationId: input.organisationId,
      request: run.request,
      runId: run.id,
      status: "PARTIAL",
      totalCostCents,
      partialResults: { steps: stepOutputs },
      finalOutput: shapedPartial,
      error: "MAX_STEPS",
      userFacingError: `I completed ${stepOutputs.length} steps (the maximum for one run). Here's what I have — ask again if you need more.`,
    });
  }

  const originalUserPrompt = readOriginalUserPrompt(run);
  const tPost0 = Date.now();
  const shapedFinal = await finalizeModeOutput({
    organisationId: input.organisationId,
    agentRunId: run.id,
    answerMode: run.answerMode,
    raw: previousOutput,
    originalUserPrompt,
    request: run.request,
  });
  latencyTrace.postProcessMs = Date.now() - tPost0;
  if (!latencyTrace.toolMs) {
    latencyTrace.toolMs = Math.max(
      0,
      Date.now() -
        executeWallStart -
        (latencyTrace.contextLoadMs || 0) -
        (latencyTrace.planMs || 0) -
        (latencyTrace.governorMs || 0) -
        (latencyTrace.preStepContextMs || 0) -
        (latencyTrace.postProcessMs || 0),
    );
  }
  latencyTrace.totalMs = Date.now() - executeWallStart;
  logger.info("Ask latency trace", {
    runId: run.id,
    answerMode: run.answerMode,
    crmDeskFastPath: crmDeskOnly,
    ...latencyTrace,
  });

  const findingsLen = Array.isArray((shapedFinal as { findings?: unknown[] }).findings)
    ? ((shapedFinal as { findings?: unknown[] }).findings?.length ?? 0)
    : 0;
  const researchPartial =
    shapedFinal &&
    typeof shapedFinal === "object" &&
    findingsLen === 0 &&
    ((shapedFinal as { phase?: string }).phase === "PARTIAL_WITH_SOURCES" ||
      (shapedFinal as { phase?: string }).phase === "PARTIAL_WITH_GROUNDED_QUALITY" ||
      ((shapedFinal as { sourceCount?: number }).sourceCount != null &&
        Number((shapedFinal as { sourceCount?: number }).sourceCount) > 0));

  return finishRun({
    organisationId: input.organisationId,
    request: run.request,
    runId: run.id,
    status: researchPartial ? "PARTIAL" : "COMPLETED",
    totalCostCents,
    finalOutput: shapedFinal,
    partialResults: { steps: stepOutputs, latencyTrace },
  });
}

function readOriginalUserPrompt(run: {
  request: string;
  pendingBrief?: unknown;
}): string {
  const brief = run.pendingBrief;
  if (brief && typeof brief === "object" && !Array.isArray(brief)) {
    const o = brief as Record<string, unknown>;
    if (typeof o.originalUserPrompt === "string" && o.originalUserPrompt.trim()) {
      return stripClarificationMetadata(o.originalUserPrompt);
    }
  }
  return stripClarificationMetadata(run.request);
}

async function finalizeModeOutput(input: {
  organisationId: string;
  agentRunId: string;
  answerMode: import("@prisma/client").AgentAnswerMode | null;
  raw: unknown;
  originalUserPrompt?: string | null;
  request?: string | null;
}): Promise<unknown> {
  let base: unknown = input.raw;
  if (input.answerMode && input.raw != null) {
    const shaped = shapeFinalOutputForMode(input.answerMode, input.raw);
    if (shaped) {
      if (shaped.mode === "action" || shaped.mode === "deep") {
        try {
          base = await attachApprovalProposals({
            organisationId: input.organisationId,
            agentRunId: input.agentRunId,
            answerMode: input.answerMode,
            output: shaped as ActionAnswer | DeepAnswer,
          });
        } catch (error) {
          logger.warn("Capability approval proposals skipped", {
            agentRunId: input.agentRunId,
            message: error instanceof Error ? error.message : "unknown",
          });
          base = shaped;
        }
      } else {
        base = shaped;
      }
    }
  }

  // QUICK / EXECUTIVE / ACTION shapers used to drop sources/findings.
  // Carry evidence from raw, then normalise so every research payload has
  // linked findings + source cards (URL, snippet/title/author).
  if (input.raw && base && base !== input.raw) {
    base = mergeResearchEvidence(base, input.raw);
  }
  base = attachVisibleResearchEvidence(base);

  // Shape builders omit deadline metadata — preserve mandatory quality flags.
  if (
    input.raw &&
    typeof input.raw === "object" &&
    base &&
    typeof base === "object"
  ) {
    const raw = input.raw as Record<string, unknown>;
    const out = base as Record<string, unknown>;
    if (raw.analystEnrichmentSkipped === true) {
      out.analystEnrichmentSkipped = true;
    }
    if (raw.analystEnrichmentFailed === true) {
      out.analystEnrichmentFailed = true;
    }
    if (
      typeof raw.phase === "string" &&
      (raw.phase === "PARTIAL_WITH_GROUNDED_QUALITY" ||
        raw.phase === "GROUNDED_QUALITY_BEFORE_OPTIONAL_ENRICHMENT" ||
        raw.phase === "QUALITY_SCORING_FAILED" ||
        raw.phase === "ANALYST_ENRICHMENT_FAILED" ||
        raw.phase === "PARTIAL_WITH_SOURCES")
    ) {
      out.phase = raw.phase;
    }
  }

  return attachResearchQualityIfApplicable({
    organisationId: input.organisationId,
    answerMode: input.answerMode,
    originalUserPrompt: input.originalUserPrompt,
    request: input.request,
    output: base,
  });
}

function attachResearchQualityIfApplicable(input: {
  organisationId: string;
  answerMode: import("@prisma/client").AgentAnswerMode | null;
  originalUserPrompt?: string | null;
  request?: string | null;
  output: unknown;
}): unknown {
  if (!input.output || typeof input.output !== "object") return input.output;
  const obj = input.output as Record<string, unknown>;
  if (!looksLikeResearchOutput(obj)) return input.output;

  try {
    const sources = Array.isArray(obj.sources)
      ? (obj.sources as Array<Record<string, unknown>>).map((s) => ({
          url: String(s.url || ""),
          title: typeof s.title === "string" ? s.title : null,
          platform: typeof s.platform === "string" ? s.platform : null,
        }))
      : [];

    // Canonical set: Deep-shaped `findings` and/or analyst `claims`.
    // Analyst abort must not erase grounded research findings from RQS input.
    const grounded = extractCanonicalGroundedClaims(obj, {
      allowedSourceUrls: sources.map((s) => s.url).filter(Boolean),
    });
    const claims = toScoreResearchClaims(grounded);
    const sourcesForScore =
      sources.filter((s) => s.url).length > 0
        ? sources.filter((s) => s.url)
        : claims
            .filter((c) => c.sourceUrl)
            .map((c) => ({ url: c.sourceUrl!, title: null, platform: null }));

    const finalAnswerText = [
      typeof obj.shortAnswer === "string" ? obj.shortAnswer : "",
      typeof obj.summary === "string" ? obj.summary : "",
      typeof obj.brief === "string" ? obj.brief : "",
      typeof obj.executiveSummary === "string" ? obj.executiveSummary : "",
      typeof obj.answer === "string" ? obj.answer : "",
      typeof obj.keyFinding === "string" ? obj.keyFinding : "",
      typeof obj.businessImplications === "string" ? obj.businessImplications : "",
    ]
      .filter(Boolean)
      .join("\n");

    const prompt = stripClarificationMetadata(
      (input.originalUserPrompt || input.request || "").trim(),
    );
    const report = scoreResearchQuality({
      originalUserPrompt: prompt,
      researchTopic: prompt,
      resolvedIntent: null,
      answerMode: input.answerMode,
      businessSpecific: false,
      organisationId: input.organisationId,
      outputOrganisationId: input.organisationId,
      claims,
      sources: sourcesForScore,
      finalAnswerText,
      gaps: Array.isArray(obj.gaps)
        ? obj.gaps.filter((g): g is string => typeof g === "string")
        : Array.isArray(obj.unknowns)
          ? obj.unknowns.filter((g): g is string => typeof g === "string")
          : [],
      contradictions: Array.isArray(obj.contradictions)
        ? (obj.contradictions as Array<string | { description?: string; sourceUrls?: string[] }>)
            .flatMap((c) => {
              if (typeof c === "string") return [{ description: c }];
              if (c && typeof c.description === "string") {
                return [{ description: c.description, sourceUrls: c.sourceUrls }];
              }
              return [];
            })
        : [],
    });

    const analystEnrichmentFailed =
      (Array.isArray(obj.gaps) &&
        obj.gaps.some(
          (g) =>
            typeof g === "string" &&
            /structured analyst|analyst synthesis failed|enrichment/i.test(g),
        )) ||
      obj.analystEnrichmentFailed === true;

    const withQuality: Record<string, unknown> = {
      ...obj,
      researchQuality: report,
      researchQualitySummary: isWebResearchAuthRequiredOutput(obj)
        ? typeof obj.summary === "string" && /\bAUTH_REQUIRED\b/.test(obj.summary)
          ? obj.summary
          : WEB_SEARCH_MISSING_KEY_MESSAGE
        : sourcesForScore.length > 0 && claims.length === 0 && report.overall === 0
          ? "Sources collected — structured claims were incomplete; listed URLs are leads, not a 0% failure."
          : customerQualitySummary(report),
      groundedClaimCount: grounded.length,
      ...(analystEnrichmentFailed
        ? { analystEnrichmentFailed: true }
        : {}),
      ...(obj.analystEnrichmentSkipped === true
        ? { analystEnrichmentSkipped: true }
        : {}),
    };

    // Preserve explicit deadline / partial phases; otherwise surface analyst abort.
    if (
      obj.phase === "PARTIAL_WITH_GROUNDED_QUALITY" ||
      obj.phase === "GROUNDED_QUALITY_BEFORE_OPTIONAL_ENRICHMENT" ||
      obj.phase === "QUALITY_SCORING_FAILED" ||
      obj.phase === "PARTIAL_WITH_SOURCES"
    ) {
      withQuality.phase = obj.phase;
    } else if (analystEnrichmentFailed) {
      withQuality.phase = "ANALYST_ENRICHMENT_FAILED";
    }

    // Below threshold: keep best supported answer but surface limitations (never invent).
    if (!report.accepted && report.hardGateFailures.length) {
      const lim = report.limitations.slice(0, 4).join(" ");
      if (withQuality.gaps == null && withQuality.unknowns == null) {
        withQuality.gaps = report.limitations.slice(0, 6);
      }
      if (!finalAnswerText.trim()) {
        withQuality.shortAnswer =
          `I could not produce an accepted research answer yet. ${lim || "Please try again with a clearer question."}`;
      }
    }

    return withQuality;
  } catch (error) {
    logger.warn("Research quality scoring failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return {
      ...(obj as Record<string, unknown>),
      phase: "QUALITY_SCORING_FAILED",
      researchQualityError:
        error instanceof Error ? error.message : "QUALITY_SCORING_FAILED",
    };
  }
}
