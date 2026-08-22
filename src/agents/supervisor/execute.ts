import { Prisma, type AgentRunStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureAgentsRegistered, getAgent } from "@/agents";
import { planAgentRun } from "@/agents/supervisor/plan";
import type { AgentPlan, PlanStep } from "@/agents/supervisor/types";
import { assertWithinSpendCap, SpendCapExceededError } from "@/services/ai-spend-gate";
import { logger } from "@/lib/logger";
import { retrieveRelevantKnowledge } from "@/services/knowledge";
import { recordResearchToolCall } from "@/services/research-tool-calls";
import { evaluateToolPolicy } from "@/kernel";

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
    },
  });

  let plan = asPlan(run.plan);
  if (!plan) {
    const planned = await planAgentRun(run.request, {
      organisationId: input.organisationId,
      organisationName: org?.name,
      referenceAssetId: run.referenceAssetId,
    });

    if (planned.kind === "clarification") {
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

    plan = planned.plan;
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

  const stepsToRun = plan.steps.slice(0, maxSteps);
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
          .slice(0, 12_000);
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

  for (let i = 0; i < stepsToRun.length; i++) {
    const elapsedSec = (Date.now() - startedAt.getTime()) / 1000;
    if (elapsedSec > maxWallClockSeconds) {
      return finishRun({
        organisationId: input.organisationId,
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

    const label = agent.userFacingLabel(parsedInput.data as never);
    if (!label || !label.trim()) {
      return finishRun({
        organisationId: input.organisationId,
        runId: run.id,
        status: "FAILED",
        totalCostCents,
        error: "EMPTY_USER_FACING_LABEL",
        userFacingError:
          "Something went wrong preparing progress updates. Please try again — no charge was made for this step.",
      });
    }

    const estimate = agent.estimateCostCents(parsedInput.data as never);
    try {
      await assertWithinSpendCap(input.organisationId, estimate);
    } catch (error) {
      if (error instanceof SpendCapExceededError) {
        return finishRun({
          organisationId: input.organisationId,
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
        userFacingLabel: label.trim(),
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

      const result = await agent.execute(parsedInput.data as never, {
        organisationId: input.organisationId,
        agentRunId: run.id,
        agentStepId: stepRow.id,
        knowledgeContext,
        knowledgeDocumentTitles,
        knowledgeRetrievalMode,
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
        userFacingLabel: label.trim(),
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
        runId: run.id,
        status: stepOutputs.length ? "PARTIAL" : "FAILED",
        totalCostCents,
        partialResults: stepOutputs.length ? { steps: stepOutputs } : null,
        finalOutput: previousOutput,
        error: message,
        userFacingError:
          userFacing ||
          (stepOutputs.length
            ? `I completed ${stepOutputs.length} of ${stepsToRun.length} steps, then ran into a problem and stopped. Here's what I finished before that.`
            : "I couldn't finish that request. Nothing useful was produced — try again in a moment, or rephrase what you need."),
      });
    }
  }

  // Truncated by maxSteps
  if (plan.steps.length > maxSteps) {
    return finishRun({
      organisationId: input.organisationId,
      runId: run.id,
      status: "PARTIAL",
      totalCostCents,
      partialResults: { steps: stepOutputs },
      finalOutput: previousOutput,
      error: "MAX_STEPS",
      userFacingError: `I completed ${stepOutputs.length} steps (the maximum for one run). Here's what I have — ask again if you need more.`,
    });
  }

  return finishRun({
    organisationId: input.organisationId,
    runId: run.id,
    status: "COMPLETED",
    totalCostCents,
    finalOutput: previousOutput,
    partialResults: { steps: stepOutputs },
  });
}
