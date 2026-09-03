import { Prisma, type AgentRunStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureAgentsRegistered, getAgent } from "@/agents";
import { planAgentRun } from "@/agents/supervisor/plan";
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
import { scoreResearchQuality } from "@/services/research-quality";
import { stripClarificationMetadata } from "@/lib/agent-request-sanitize";

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
  const updated = await prisma.agentRun.updateMany({
    where: { id: input.runId, organisationId: input.organisationId },
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
    try {
      await recordEpisodeFromAgentRun({
        organisationId: input.organisationId,
        agentRunId: input.runId,
        request: input.request,
        status: input.status,
        finalOutput: input.finalOutput,
      });
    } catch (error) {
      logger.warn("Episodic memory write skipped", {
        runId: input.runId,
        organisationId: input.organisationId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return {
    runId: input.runId,
    status: input.status,
    finalOutput: input.finalOutput ?? null,
    partialResults: input.partialResults ?? null,
    userFacingError: input.userFacingError ?? null,
  };
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
    where: { id: input.runId, organisationId: input.organisationId },
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

  const org = await prisma.organisation.findFirst({
    where: { id: input.organisationId, deletedAt: null },
    select: { id: true, name: true },
  });

  const limits = await loadLimits(input.organisationId);
  const maxSteps = run.maxSteps || limits.maxSteps;
  const maxWallClockSeconds = run.maxWallClockSeconds || limits.maxWallClockSeconds;
  const maxSpendCents =
    run.maxSpendCents ?? limits.maxSpendCentsPerRun ?? null;

  const startedAt = run.startedAt ?? new Date();
  await prisma.agentRun.updateMany({
    where: { id: run.id, organisationId: input.organisationId },
    data: {
      status: "PLANNING",
      startedAt,
      maxSteps,
      maxWallClockSeconds,
      maxSpendCents,
      // Customer-facing stage while planning (no agents/tools jargon).
      plainEnglishPlan: run.plainEnglishPlan || CUSTOMER_PROGRESS_STAGES.understanding,
    },
  });

  // Understanding / business-context stages (customer-facing only).
  let businessContextKnownFacts: string[] = [];
  try {
    const askCtx = await resolveAskBusinessContext({
      organisationId: input.organisationId,
      request: run.request,
    });
    businessContextKnownFacts = askCtx.knownFacts;
    if (askCtx.knownFacts.length && !asPlan(run.plan)) {
      await prisma.agentRun.updateMany({
        where: { id: run.id, organisationId: input.organisationId, status: "PLANNING" },
        data: { plainEnglishPlan: CUSTOMER_PROGRESS_STAGES.context },
      });
    }
  } catch (error) {
    logger.warn("Ask business context resolve skipped", {
      runId: run.id,
      message: error instanceof Error ? error.message : "unknown",
    });
  }

  let plan = asPlan(run.plan);
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
        const askCtx = await resolveAskBusinessContext({
          organisationId: input.organisationId,
          request: run.request,
        });
        suppress = shouldSuppressBusinessClarification(planned.question, askCtx);
      } catch {
        suppress = false;
      }

      if (!suppress) {
        await prisma.agentRun.updateMany({
          where: { id: run.id, organisationId: input.organisationId },
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
        await prisma.agentRun.updateMany({
          where: { id: run.id, organisationId: input.organisationId },
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

    await prisma.agentRun.updateMany({
      where: { id: run.id, organisationId: input.organisationId },
      data: {
        plan: plan as unknown as Prisma.InputJsonValue,
        plainEnglishPlan: plan.plainEnglishPlan,
        clarificationQuestion: null,
        clarificationOptions: Prisma.DbNull,
        status: "RUNNING",
      },
    });
  } else {
    await prisma.agentRun.updateMany({
      where: { id: run.id, organisationId: input.organisationId },
      data: {
        status: "RUNNING",
        plainEnglishPlan: plan.plainEnglishPlan,
      },
    });
  }

  // Map answer mode into Compute Governor (single pipeline) and apply budgets.
  let governedMaxSteps = maxSteps;
  let governedContextChars: number | null = null;
  if (run.answerMode) {
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
  }

  const stepsToRun = plan.steps.slice(0, governedMaxSteps);
  const stepOutputs: Array<{ agentName: string; userFacingLabel: string; output: unknown }> =
    [];
  let totalCostCents = run.totalCostCents || 0;
  let previousOutput: unknown = null;

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

  for (let i = 0; i < stepsToRun.length; i++) {
    const elapsedSec = (Date.now() - startedAt.getTime()) / 1000;
    if (elapsedSec > maxWallClockSeconds) {
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
      return finishRun({
        organisationId: input.organisationId,
        request: run.request,
        runId: run.id,
        status: "PARTIAL",
        totalCostCents,
        partialResults: { steps: stepOutputs },
        finalOutput: previousOutput,
        error: "MAX_SPEND_PER_RUN",
        userFacingError: `I finished ${stepOutputs.length} of ${stepsToRun.length} steps, then paused to stay within your spend limit for this run. You can raise the limit in settings if you want longer runs.`,
      });
    }

    const step = stepsToRun[i]!;
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

      const result = await agent.execute(parsedInput.data as never, {
        organisationId: input.organisationId,
        agentRunId: run.id,
        agentStepId: stepRow.id,
        knowledgeContext,
        knowledgeDocumentTitles,
        knowledgeRetrievalMode,
        episodicContext,
      });

      const durationMs = Date.now() - stepStarted;
      const costCents = result.costCents ?? 0;
      totalCostCents += costCents;

      await prisma.agentStep.updateMany({
        where: {
          id: stepRow.id,
          organisationId: input.organisationId,
          agentRunId: run.id,
        },
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

      await prisma.agentRun.updateMany({
        where: { id: run.id, organisationId: input.organisationId },
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
          verification: criticOut,
        };
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

      await prisma.agentStep.updateMany({
        where: {
          id: stepRow.id,
          organisationId: input.organisationId,
          agentRunId: run.id,
        },
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
  const shapedFinal = await finalizeModeOutput({
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
    status: "COMPLETED",
    totalCostCents,
    finalOutput: shapedFinal,
    partialResults: { steps: stepOutputs },
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
  const looksLikeResearch =
    Array.isArray(obj.claims) ||
    Array.isArray(obj.sources) ||
    typeof obj.researchJobId === "string" ||
    typeof obj.brief === "string" ||
    typeof obj.shortAnswer === "string";
  if (!looksLikeResearch) return input.output;

  try {
    const claims = Array.isArray(obj.claims)
      ? (obj.claims as Array<Record<string, unknown>>).map((c) => ({
          claim: String(c.claim || ""),
          sourceUrl: typeof c.sourceUrl === "string" ? c.sourceUrl : undefined,
          evidenceExcerpt: typeof c.evidenceExcerpt === "string" ? c.evidenceExcerpt : undefined,
          claimKind: typeof c.claimKind === "string" ? c.claimKind : undefined,
          confidence: typeof c.confidence === "number" ? c.confidence : undefined,
        }))
      : [];
    const sources = Array.isArray(obj.sources)
      ? (obj.sources as Array<Record<string, unknown>>).map((s) => ({
          url: String(s.url || ""),
          title: typeof s.title === "string" ? s.title : null,
          platform: typeof s.platform === "string" ? s.platform : null,
        }))
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
      sources: sources.filter((s) => s.url),
      finalAnswerText,
      gaps: Array.isArray(obj.gaps) ? obj.gaps.filter((g): g is string => typeof g === "string") : [],
      contradictions: Array.isArray(obj.contradictions)
        ? (obj.contradictions as Array<{ description?: string; sourceUrls?: string[] }>)
            .filter((c) => c && typeof c.description === "string")
            .map((c) => ({ description: c.description!, sourceUrls: c.sourceUrls }))
        : [],
    });

    const withQuality: Record<string, unknown> = {
      ...obj,
      researchQuality: report,
      researchQualitySummary: `Research quality: ${report.overall}% · ${report.confidenceLabel}`,
    };

    // Below threshold: keep best supported answer but surface limitations (never invent).
    if (!report.accepted && report.hardGateFailures.length) {
      const lim = report.limitations.slice(0, 4).join(" ");
      if (withQuality.gaps == null) {
        withQuality.gaps = report.limitations.slice(0, 6);
      }
      if (!finalAnswerText.trim()) {
        withQuality.shortAnswer =
          `I could not produce an accepted research answer yet. ${lim || "Please try again with a clearer question."}`;
      }
    }

    return withQuality;
  } catch (error) {
    logger.warn("Research quality scoring skipped", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return input.output;
  }
}
