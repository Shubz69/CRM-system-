import { AgentAnswerMode, AgentDetailRetention, Prisma, type AgentRun, type AgentStep } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueueAgentRunJob } from "@/jobs/agent-runs";
import { ensureAgentsRegistered } from "@/agents";
import {
  WorkspaceAccessError,
  assertActiveWorkspaceAccess,
} from "@/services/workspace-access";
import { logger } from "@/lib/logger";
import { STEPS_CLEARED_MESSAGE } from "@/services/agent-retention";
import {
  getOrganisationAiBudget,
  getOrganisationPeriodSpendCents,
} from "@/services/ai-spend-gate";
import { ensureBuiltinToolsRegistered, listTools } from "@/kernel";
import {
  answerModeFromFormatOption,
  detectAnswerModeFromLanguage,
  isModeShapedOutput,
  parseAnswerMode,
} from "@/services/answer-modes";

export type AgentRunProgress = {
  runId: string;
  status: AgentRun["status"];
  request: string;
  answerMode: AgentAnswerMode | null;
  plainEnglishPlan: string | null;
  clarificationQuestion: string | null;
  clarificationOptions: string[] | null;
  /** Imaging: derived prompt awaiting edit/confirm. */
  pendingPrompt: string | null;
  pendingCostEstimateCents: number | null;
  referenceAssetId: string | null;
  /** Plain cost estimate before generation confirm. */
  pendingCostNote: string | null;
  /** Remaining monthly AI allowance in plain English — never token counts. */
  remainingAllowanceNote: string | null;
  currentStep: {
    position: number;
    userFacingLabel: string;
    userFacingStatus: string | null;
    status: AgentStep["status"];
  } | null;
  stepsCompleted: number;
  stepsTotal: number;
  elapsedMs: number;
  totalCostCents: number;
  /** Plain remaining allowance copy when known — never raw token counts. */
  costNote: string | null;
  outputSoFar: unknown;
  finalOutput: unknown;
  userFacingError: string | null;
  /**
   * True when step detail was pruned by retention.
   * UI should keep showing the brief and explain that detail was cleared.
   */
  stepsDetailCleared: boolean;
  stepsDetailClearedMessage: string | null;
  steps: Array<{
    position: number;
    userFacingLabel: string;
    userFacingStatus: string | null;
    status: AgentStep["status"];
    output: unknown;
    costCents: number;
    detailRetention: AgentStep["detailRetention"];
  }>;
  nextActions: string[];
  /**
   * Agent Kernel observability — real tool invocations + registry summary.
   * API strips this for non-admin callers.
   */
  kernel?: {
    toolsInvoked: Array<{
      toolName: string;
      durationMs: number | null;
      error: string | null;
    }>;
    registeredTools: Array<{ name: string; risk: string; description: string }>;
    knowledgeUsed: {
      documentTitles: string[];
      mode: string;
    } | null;
    memoryUsed: { episodeCount: number } | null;
  };
};

function parseOptions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

function nextActionsFor(
  status: AgentRun["status"],
  finalOutput: unknown,
  answerMode?: AgentAnswerMode | null,
): string[] {
  const modeShaped = isModeShapedOutput(finalOutput);
  const looksLikeResearch =
    modeShaped ||
    (finalOutput &&
      typeof finalOutput === "object" &&
      (Array.isArray((finalOutput as { claims?: unknown }).claims) ||
        typeof (finalOutput as { researchJobId?: unknown }).researchJobId === "string"));
  const looksLikeImage =
    finalOutput &&
    typeof finalOutput === "object" &&
    typeof (finalOutput as { url?: unknown }).url === "string" &&
    typeof (finalOutput as { assetId?: unknown }).assetId === "string";

  switch (status) {
    case "COMPLETED":
      if (modeShaped && (finalOutput.mode === "action" || finalOutput.mode === "deep")) {
        return [
          "Create opportunity",
          "Draft content",
          "Save research",
          "Create mission",
          "Prepare outreach",
          "Ask something else",
        ];
      }
      if (looksLikeResearch) {
        return [
          "Create opportunity",
          "Draft content",
          "Save research",
          "Create goal",
          "Create automation",
          "Ask something else",
        ];
      }
      if (looksLikeImage) {
        return ["Make another image", "Ask something else"];
      }
      return ["Ask something else", "Run this again"];
    case "PARTIAL":
      if (looksLikeResearch) {
        return [
          "Create opportunity",
          "Draft content",
          "Save research",
          "Try again",
          "Ask something else",
        ];
      }
      return ["Try again", "Ask something else"];
    case "FAILED":
      return ["Try again", "Rephrase your request"];
    case "AWAITING_CLARIFICATION":
      return ["Pick one of the options above"];
    case "AWAITING_PROMPT_CONFIRM":
      return ["Edit the prompt if needed, then confirm to generate"];
    case "RUNNING":
    case "PLANNING":
    case "PENDING":
      return ["Sit tight — progress updates as each step finishes"];
    default:
      return answerMode ? ["Ask something else"] : ["Ask something else"];
  }
}

function costNote(totalCostCents: number): string | null {
  if (totalCostCents <= 0) return "No AI charge for this run so far.";
  if (totalCostCents < 100) {
    return `About ${totalCostCents}¢ used for this run.`;
  }
  const dollars = (totalCostCents / 100).toFixed(2);
  return `About $${dollars} used for this run.`;
}

function pendingCostNote(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  if (cents <= 0) return "No generation charge estimated.";
  if (cents < 100) return `Estimated generation cost: about ${cents}¢.`;
  return `Estimated generation cost: about $${(cents / 100).toFixed(2)}.`;
}

function remainingAllowanceNote(spentCents: number, capCents: number | null): string | null {
  const spent =
    spentCents <= 0
      ? null
      : spentCents < 100
        ? `About ${spentCents}¢ used on AI this month.`
        : `About $${(spentCents / 100).toFixed(2)} used on AI this month.`;

  if (capCents == null) {
    return spent;
  }

  const left = Math.max(0, capCents - spentCents);
  const low = left <= Math.max(500, Math.floor(capCents * 0.2));
  const leftNote =
    left < 100
      ? `About ${left}¢ left in this month's AI allowance.`
      : `About $${(left / 100).toFixed(2)} left in this month's AI allowance.`;
  const warn = low ? " AI allowance is running low." : "";

  if (spent) return `${spent} ${leftNote}${warn}`.trim();
  return `${leftNote}${warn}`.trim();
}

/**
 * Create an AgentRun and enqueue execution on agent-runs. Returns immediately.
 */
export async function createAndEnqueueAgentRun(input: {
  organisationId: string;
  userId?: string | null;
  request: string;
  triggeredBy?: "user" | "system" | "schedule";
  referenceAssetId?: string | null;
  answerMode?: AgentAnswerMode | string | null;
}): Promise<{ runId: string; jobId: string }> {
  ensureAgentsRegistered();
  const request = input.request.trim();
  if (!request) {
    throw new Error("Request cannot be empty");
  }

  // Validate org (+ membership when a user is attached) before any FK write.
  if (input.userId) {
    await assertActiveWorkspaceAccess({
      userId: input.userId,
      organisationId: input.organisationId,
    });
  } else {
    const org = await prisma.organisation.findFirst({
      where: { id: input.organisationId, deletedAt: null },
      select: { id: true },
    });
    if (!org) {
      throw new WorkspaceAccessError(
        "SESSION_ORG_INVALID",
        "Your workspace is no longer available. Please sign in again.",
      );
    }
  }

  if (input.referenceAssetId) {
    const asset = await prisma.asset.findFirst({
      where: {
        id: input.referenceAssetId,
        organisationId: input.organisationId,
      },
      select: { id: true },
    });
    if (!asset) {
      throw new Error("Reference image not found for this organisation");
    }
  }

  const limits = await prisma.organisationAgentLimits.findUnique({
    where: { organisationId: input.organisationId },
  });

  const answerMode =
    parseAnswerMode(input.answerMode) ?? detectAnswerModeFromLanguage(request);

  const run = await prisma.agentRun.create({
    data: {
      organisationId: input.organisationId,
      userId: input.userId ?? null,
      triggeredBy: input.triggeredBy ?? "user",
      request,
      status: "PENDING",
      answerMode: answerMode ?? null,
      maxSteps: limits?.maxSteps ?? 8,
      maxWallClockSeconds: limits?.maxWallClockSeconds ?? 600,
      maxSpendCents: limits?.maxSpendCentsPerRun ?? null,
      referenceAssetId: input.referenceAssetId ?? null,
    },
  });

  try {
    const { jobId } = await enqueueAgentRunJob({
      name: "agent-framework-run",
      organisationId: input.organisationId,
      payload: { agentRunId: run.id },
    });

    await prisma.agentRun.updateMany({
      where: { id: run.id, organisationId: input.organisationId },
      data: { bullJobId: jobId },
    });

    return { runId: run.id, jobId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Enqueue failed";
    await prisma.agentRun.updateMany({
      where: { id: run.id, organisationId: input.organisationId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: message,
        userFacingError:
          "I couldn't start that request because the background worker isn't reachable. Please try again in a moment.",
      },
    });
    // Re-throw a plain-English error — never bubble Redis/Prisma text to API clients.
    throw new Error(
      "I couldn't start that request because the background worker isn't reachable. Please try again in a moment.",
    );
  }
}

/** Apply a single clarification answer and re-enqueue execution. */
export async function clarifyAndEnqueueAgentRun(input: {
  organisationId: string;
  runId: string;
  selectedOption: string;
}): Promise<{ runId: string; jobId: string }> {
  const run = await prisma.agentRun.findFirst({
    where: {
      id: input.runId,
      organisationId: input.organisationId,
      status: "AWAITING_CLARIFICATION",
    },
  });
  if (!run) {
    throw new Error("Run not awaiting clarification");
  }

  const options = parseOptions(run.clarificationOptions) || [];
  if (!options.includes(input.selectedOption)) {
    throw new Error("Invalid clarification option");
  }

  const formatMode = answerModeFromFormatOption(input.selectedOption);
  const combined = `${run.request}\n\n[User chose: ${input.selectedOption}]`;

  await prisma.agentRun.updateMany({
    where: { id: run.id, organisationId: input.organisationId },
    data: {
      request: combined,
      status: "PENDING",
      ...(formatMode ? { answerMode: formatMode } : {}),
      clarificationQuestion: null,
      clarificationOptions: Prisma.DbNull,
      plan: Prisma.DbNull,
      plainEnglishPlan: null,
      error: null,
      userFacingError: null,
      finishedAt: null,
    },
  });

  const { jobId } = await enqueueAgentRunJob({
    name: "agent-framework-run",
    organisationId: input.organisationId,
    payload: { agentRunId: run.id },
  });

  await prisma.agentRun.updateMany({
    where: { id: run.id, organisationId: input.organisationId },
    data: { bullJobId: jobId },
  });

  logger.info("Agent run clarified and re-enqueued", {
    runId: run.id,
    organisationId: input.organisationId,
    jobId,
  });

  return { runId: run.id, jobId };
}

/**
 * Confirm (or edit) the derived imaging prompt, then enqueue generation only.
 */
export async function confirmImagingPromptAndEnqueue(input: {
  organisationId: string;
  runId: string;
  confirmedPrompt: string;
}): Promise<{ runId: string; jobId: string }> {
  ensureAgentsRegistered();
  const prompt = input.confirmedPrompt.trim().slice(0, 4000);
  if (prompt.length < 8) {
    throw new Error("Prompt is too short — add a bit more detail before generating.");
  }

  const run = await prisma.agentRun.findFirst({
    where: {
      id: input.runId,
      organisationId: input.organisationId,
      status: "AWAITING_PROMPT_CONFIRM",
    },
  });
  if (!run) {
    throw new Error("Run not awaiting prompt confirmation");
  }

  const referenceAssetId = run.referenceAssetId;
  if (!referenceAssetId) {
    throw new Error("This run is missing a reference image");
  }

  const estimate = run.pendingCostEstimateCents ?? 0;
  const plan = {
    steps: [
      {
        agentName: "imaging_generate",
        input: {
          prompt,
          referenceAssetId,
          request: run.request,
        },
      },
    ],
    plainEnglishPlan: `I'll generate the image from your confirmed prompt${
      estimate > 0
        ? ` (about ${estimate < 100 ? `${estimate}¢` : `$${(estimate / 100).toFixed(2)}`} estimated)`
        : ""
    }.`,
  };

  await prisma.agentRun.updateMany({
    where: { id: run.id, organisationId: input.organisationId },
    data: {
      pendingPrompt: prompt,
      plan: plan as unknown as Prisma.InputJsonValue,
      plainEnglishPlan: plan.plainEnglishPlan,
      status: "PENDING",
      error: null,
      userFacingError: null,
      finishedAt: null,
      finalOutput: Prisma.DbNull,
    },
  });

  const { jobId } = await enqueueAgentRunJob({
    name: "agent-framework-run",
    organisationId: input.organisationId,
    payload: { agentRunId: run.id },
  });

  await prisma.agentRun.updateMany({
    where: { id: run.id, organisationId: input.organisationId },
    data: { bullJobId: jobId },
  });

  logger.info("Imaging prompt confirmed and generation enqueued", {
    runId: run.id,
    organisationId: input.organisationId,
    jobId,
  });

  return { runId: run.id, jobId };
}

/**
 * Progress snapshot for UI polling. Always org-scoped.
 */
export async function getAgentRunProgress(input: {
  organisationId: string;
  runId: string;
}): Promise<AgentRunProgress | null> {
  const run = await prisma.agentRun.findFirst({
    where: { id: input.runId, organisationId: input.organisationId },
    include: {
      steps: {
        where: { organisationId: input.organisationId },
        orderBy: { position: "asc" },
        include: {
          toolCalls: {
            where: { organisationId: input.organisationId },
            orderBy: { createdAt: "asc" },
            select: { toolName: true, durationMs: true, error: true, result: true },
          },
        },
      },
    },
  });
  if (!run) return null;

  const planSteps =
    run.plan && typeof run.plan === "object" && Array.isArray((run.plan as { steps?: unknown }).steps)
      ? ((run.plan as { steps: unknown[] }).steps.length as number)
      : run.steps.length;

  const stepsCompleted = run.steps.filter((s) => s.status === "COMPLETED").length;
  const current =
    run.steps.find((s) => s.status === "RUNNING") ||
    run.steps.filter((s) => s.status === "COMPLETED").at(-1) ||
    null;

  const started = run.startedAt?.getTime() ?? run.createdAt.getTime();
  const ended = run.finishedAt?.getTime() ?? Date.now();

  const stepsDetailCleared = run.steps.some(
    (s) =>
      s.detailRetention === AgentDetailRetention.COMPACT ||
      s.detailRetention === AgentDetailRetention.SKELETON,
  );

  const lastCompletedOutput = stepsDetailCleared
    ? null
    : [...run.steps].reverse().find((s) => s.status === "COMPLETED" && s.output != null)?.output ??
      null;

  const displayOutput = run.finalOutput ?? lastCompletedOutput;
  const budget = await getOrganisationAiBudget(input.organisationId);
  // Always load period spend so Ask can show usage even when no hard cap is set.
  const spentCents = await getOrganisationPeriodSpendCents(input.organisationId);

  ensureBuiltinToolsRegistered();
  const toolsInvoked = run.steps.flatMap((s) =>
    s.toolCalls.map((t) => ({
      toolName: t.toolName,
      durationMs: t.durationMs,
      error: t.error,
    })),
  );
  const knowledgeTool = run.steps
    .flatMap((s) => s.toolCalls)
    .find((t) => t.toolName === "knowledge.retrieve" && t.result && typeof t.result === "object");
  const knowledgeResult = knowledgeTool?.result as
    | { documentTitles?: unknown; mode?: unknown }
    | undefined;
  const knowledgeUsed =
    knowledgeResult && Array.isArray(knowledgeResult.documentTitles)
      ? {
          documentTitles: knowledgeResult.documentTitles.filter(
            (t): t is string => typeof t === "string",
          ),
          mode: typeof knowledgeResult.mode === "string" ? knowledgeResult.mode : "unknown",
        }
      : null;

  const memoryTool = run.steps
    .flatMap((s) => s.toolCalls)
    .find((t) => t.toolName === "memory.retrieve" && t.result && typeof t.result === "object");
  const memoryResult = memoryTool?.result as { episodeCount?: unknown } | undefined;
  const memoryUsed =
    memoryResult && typeof memoryResult.episodeCount === "number"
      ? { episodeCount: memoryResult.episodeCount }
      : null;

  return {
    runId: run.id,
    status: run.status,
    request: run.request,
    answerMode: run.answerMode ?? null,
    plainEnglishPlan: run.plainEnglishPlan,
    clarificationQuestion: run.clarificationQuestion,
    clarificationOptions: parseOptions(run.clarificationOptions),
    pendingPrompt: run.pendingPrompt,
    pendingCostEstimateCents: run.pendingCostEstimateCents,
    referenceAssetId: run.referenceAssetId,
    pendingCostNote: pendingCostNote(run.pendingCostEstimateCents),
    remainingAllowanceNote: remainingAllowanceNote(
      spentCents,
      budget?.monthlyCapCents ?? null,
    ),
    currentStep: current
      ? {
          position: current.position,
          userFacingLabel: current.userFacingLabel,
          userFacingStatus: current.userFacingStatus,
          status: current.status,
        }
      : null,
    stepsCompleted,
    stepsTotal: Math.max(planSteps, run.steps.length),
    elapsedMs: Math.max(0, ended - started),
    totalCostCents: run.totalCostCents,
    costNote: costNote(run.totalCostCents),
    outputSoFar: lastCompletedOutput,
    finalOutput: run.finalOutput,
    userFacingError: run.userFacingError,
    stepsDetailCleared,
    stepsDetailClearedMessage: stepsDetailCleared ? STEPS_CLEARED_MESSAGE : null,
    steps: run.steps.map((s) => ({
      position: s.position,
      userFacingLabel: s.userFacingLabel,
      userFacingStatus: s.userFacingStatus,
      status: s.status,
      output: stepsDetailCleared ? null : s.output,
      costCents: s.costCents,
      detailRetention: s.detailRetention,
    })),
    nextActions: nextActionsFor(run.status, displayOutput, run.answerMode),
    kernel: {
      toolsInvoked,
      registeredTools: listTools().map((t) => ({
        name: t.name,
        risk: t.risk,
        description: t.description,
      })),
      knowledgeUsed,
      memoryUsed,
    },
  };
}
