import { AgentDetailRetention, Prisma, type AgentRun, type AgentStep } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueueAgentRunJob } from "@/jobs/agent-runs";
import { ensureAgentsRegistered } from "@/agents";
import { logger } from "@/lib/logger";
import { STEPS_CLEARED_MESSAGE } from "@/services/agent-retention";

export type AgentRunProgress = {
  runId: string;
  status: AgentRun["status"];
  request: string;
  plainEnglishPlan: string | null;
  clarificationQuestion: string | null;
  clarificationOptions: string[] | null;
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
};

function parseOptions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

function nextActionsFor(status: AgentRun["status"]): string[] {
  switch (status) {
    case "COMPLETED":
      return ["Ask something else", "Run this again", "Copy the answer"];
    case "PARTIAL":
      return ["Try again", "Ask something else"];
    case "FAILED":
      return ["Try again", "Rephrase your request"];
    case "AWAITING_CLARIFICATION":
      return ["Pick one of the options above"];
    case "RUNNING":
    case "PLANNING":
    case "PENDING":
      return ["Sit tight — progress updates as each step finishes"];
    default:
      return ["Ask something else"];
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

/**
 * Create an AgentRun and enqueue execution on agent-runs. Returns immediately.
 */
export async function createAndEnqueueAgentRun(input: {
  organisationId: string;
  userId?: string | null;
  request: string;
  triggeredBy?: "user" | "system" | "schedule";
}): Promise<{ runId: string; jobId: string }> {
  ensureAgentsRegistered();
  const request = input.request.trim();
  if (!request) {
    throw new Error("Request cannot be empty");
  }

  const limits = await prisma.organisationAgentLimits.findUnique({
    where: { organisationId: input.organisationId },
  });

  const run = await prisma.agentRun.create({
    data: {
      organisationId: input.organisationId,
      userId: input.userId ?? null,
      triggeredBy: input.triggeredBy ?? "user",
      request,
      status: "PENDING",
      maxSteps: limits?.maxSteps ?? 8,
      maxWallClockSeconds: limits?.maxWallClockSeconds ?? 600,
      maxSpendCents: limits?.maxSpendCentsPerRun ?? null,
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
    throw error;
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

  const combined = `${run.request}\n\n[User chose: ${input.selectedOption}]`;

  await prisma.agentRun.updateMany({
    where: { id: run.id, organisationId: input.organisationId },
    data: {
      request: combined,
      status: "PENDING",
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

  return {
    runId: run.id,
    status: run.status,
    request: run.request,
    plainEnglishPlan: run.plainEnglishPlan,
    clarificationQuestion: run.clarificationQuestion,
    clarificationOptions: parseOptions(run.clarificationOptions),
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
    nextActions: nextActionsFor(run.status),
  };
}
