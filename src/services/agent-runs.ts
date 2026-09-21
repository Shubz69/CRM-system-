import { AgentAnswerMode, AgentDetailRetention, Prisma, type AgentRun, type AgentStep } from "@prisma/client";
import { prisma } from "@/lib/db";
import { asSafePrismaId, updateOrgScopedById } from "@/lib/safe-prisma-id";
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
import { ensureBuiltinToolsRegistered } from "@/kernel";
import {
  answerModeFromFormatOption,
  detectAnswerModeFromLanguage,
  isModeShapedOutput,
  parseAnswerMode,
} from "@/services/answer-modes";
import { stripClarificationMetadata } from "@/lib/agent-request-sanitize";
import {
  looksLikeCrmInternal,
  looksLikeOperatorBrief,
  looksLikeResearch,
  isQuickResearchAsk,
} from "@/agents/supervisor/plan";
import { executeAgentRun } from "@/agents/supervisor/execute";
import { researchWallClockCapSeconds } from "@/agents/supervisor/research-deadline";
import {
  hydrateBlankResearchFinalOutput,
  honestEmptyResearchPartial,
  salvageResearchPartialFromDb,
} from "@/agents/supervisor/research-salvage";
import { attachVisibleResearchEvidence } from "@/lib/research-visible-evidence";
import { isHostedWorkerLive, shouldEnqueueDurableAgentRun } from "@/services/worker-heartbeat";
import { after } from "next/server";

const orgLimitsCache = new Map<
  string,
  { at: number; value: Awaited<ReturnType<typeof prisma.organisationAgentLimits.findUnique>> }
>();
const ORG_LIMITS_CACHE_MS = 60_000;

async function getCachedOrganisationAgentLimits(organisationId: string) {
  const hit = orgLimitsCache.get(organisationId);
  if (hit && Date.now() - hit.at < ORG_LIMITS_CACHE_MS) return hit.value;
  const value = await prisma.organisationAgentLimits.findUnique({
    where: { organisationId },
  });
  orgLimitsCache.set(organisationId, { at: Date.now(), value });
  return value;
}

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
  /** Wall-clock spans from worker (ms) — for latency diagnosis, not customer copy. */
  latencyTrace?: Record<string, number> | null;
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

/** Exported for unit tests — customer-facing run usage copy. */
export function costNote(
  totalCostCents: number,
  status?: string | null,
): string | null {
  if (totalCostCents <= 0) {
    if (
      status === "RUNNING" ||
      status === "PLANNING" ||
      status === "PENDING" ||
      status === "AWAITING_CLARIFICATION" ||
      status === "AWAITING_PROMPT_CONFIRM"
    ) {
      return "Usage updates after tool calls complete.";
    }
    if (status === "FAILED" || status === "PARTIAL") {
      return "Usage for this run may still appear in monthly AI spend.";
    }
    // Completed CRM/internal desk runs often truly cost 0¢ (no model spend).
    if (status === "COMPLETED") {
      return "No paid AI usage recorded for this run (workspace data only, or search cost still settling).";
    }
    return "No recorded AI usage for this run yet.";
  }
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
 *
 * QUICK CRM desk and QUICK web research use an in-process sync fast-path (same
 * executeAgentRun) to avoid BullMQ queue wait dominating first-progress/final latency.
 * Deep / imaging remain queued. Wall-clock for research starts at execute, not enqueue.
 */
export async function createAndEnqueueAgentRun(input: {
  organisationId: string;
  userId?: string | null;
  request: string;
  triggeredBy?: "user" | "system" | "schedule";
  referenceAssetId?: string | null;
  answerMode?: AgentAnswerMode | string | null;
  /** When the HTTP layer already asserted membership, skip a second DB round-trip. */
  accessAlreadyVerified?: boolean;
}): Promise<{
  runId: string;
  jobId: string;
  plainEnglishPlan: string;
  syncFastPath: boolean;
  acceptMs: number;
  status?: AgentRun["status"];
  finalOutput?: unknown;
  answerMode?: AgentAnswerMode | null;
  totalCostCents?: number;
  costNote?: string | null;
}> {
  const acceptStarted = Date.now();
  ensureAgentsRegistered();
  const request = input.request.trim();
  if (!request) {
    throw new Error("Request cannot be empty");
  }

  // Validate org (+ membership when a user is attached) before any FK write.
  if (!input.accessAlreadyVerified) {
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

  const detectedMode =
    parseAnswerMode(input.answerMode) ?? detectAnswerModeFromLanguage(request);
  // Sourced web asks without an explicit mode run as Quick FAST — format
  // clarification + queue wait was burning the 12s ceiling before any search.
  const answerMode =
    detectedMode ?? (looksLikeResearch(request) ? AgentAnswerMode.QUICK : null);

  const syntheticJudgment =
    /\bsynthetic qa\b/i.test(request) ||
    /\bdo not browse\b/i.test(request) ||
    /\bno live web\b/i.test(request);

  const crmQuickSync =
    (answerMode === AgentAnswerMode.QUICK || answerMode === AgentAnswerMode.ACTION) &&
    !input.referenceAssetId &&
    (looksLikeCrmInternal(request) || looksLikeOperatorBrief(request) || syntheticJudgment) &&
    (syntheticJudgment ||
      !/\b(research|look up|investigate|compare|gdpr|ico guidance)\b/i.test(request));

  const quickResearchSync =
    isQuickResearchAsk(answerMode, request) && !input.referenceAssetId;

  const inProcessSync = crmQuickSync || quickResearchSync;

  const looksLikeResearchAsk =
    !crmQuickSync &&
    (answerMode === AgentAnswerMode.DEEP ||
      looksLikeResearch(request) ||
      /\b(research|look up|investigate|compare|gdpr|ico guidance)\b/i.test(request));

  // Hot path: skip OrganisationAgentLimits round-trip for CRM Quick/Action sync.
  // Cache non-sync lookups briefly — rapid DEEP creates were paying a DB RTT each time.
  const limits = inProcessSync
    ? null
    : await getCachedOrganisationAgentLimits(input.organisationId);

  const initialPlan = crmQuickSync
    ? looksLikeOperatorBrief(request)
      ? "Checking your CRM — building a prioritised operator brief…"
      : /\b(pipeline|stuck|stalled|open deals?)\b/i.test(request)
        ? "Reviewing your pipeline…"
        : /\b(inbox|reply|follow[- ]?up|conversation)\b/i.test(request)
          ? "Checking your inbox…"
          : "Checking your CRM…"
    : quickResearchSync
      ? `I'll do a fast sourced scan of “${request.slice(0, 80)}” and give you a short answer.`
      : "Preparing your answer…";

  const run = await prisma.agentRun.create({
    data: {
      organisationId: input.organisationId,
      userId: input.userId ?? null,
      triggeredBy: input.triggeredBy ?? "user",
      request,
      status: "PENDING",
      startedAt: new Date(),
      // Immediate customer-visible progress (queue acceptance) — not fake completion.
      plainEnglishPlan: initialPlan,
      answerMode: answerMode ?? null,
      maxSteps: limits?.maxSteps ?? 8,
      maxWallClockSeconds: looksLikeResearchAsk
        ? Math.min(
            limits?.maxWallClockSeconds ?? 600,
            researchWallClockCapSeconds(answerMode),
          )
        : limits?.maxWallClockSeconds ?? 600,
      maxSpendCents: limits?.maxSpendCentsPerRun ?? null,
      referenceAssetId: input.referenceAssetId ?? null,
      // Immutable provenance — never overwritten with clarification chrome.
      pendingBrief: {
        originalUserPrompt: request,
        clarifications: [] as string[],
        answerMode: answerMode ?? null,
        resolvedIntent: null,
        businessContextUsed: [] as string[],
      } as Prisma.InputJsonValue,
      partialResults: {
        latencyTrace: {
          enqueuedAt: Date.now(),
          syncFastPath: inProcessSync ? 1 : 0,
        },
      } as Prisma.InputJsonValue,
    },
  });
  // Early accept clock (plan persisted). Durable enqueue extends acceptMs below so
  // SERVER_ACCEPT reflects runId-available latency including Redis.
  let acceptMs = Date.now() - acceptStarted;

  if (inProcessSync) {
    // Operator briefs can take several seconds — accept fast via after() keepalive.
    // Light CRM facts finish in <1s of tool time; awaiting them removes the multi-second
    // after() scheduling delay that previously dominated Quick P50 (~6s with ~400ms tool).
    // Quick research is awaited in-request so the client gets findings without depending
    // on BullMQ pickup (queue wait was burning the 12s research ceiling).
    const deferHeavyBrief = crmQuickSync && looksLikeOperatorBrief(request);

    const runExecute = async () => {
      try {
        await executeAgentRun({
          organisationId: input.organisationId,
          runId: run.id,
        });
        await updateOrgScopedById(prisma.agentRun, {
              id: run.id,
              organisationId: input.organisationId,
              data: { bullJobId: quickResearchSync ? `sync-quick-research:${run.id}` : `sync-quick-crm:${run.id}` },
        });
        logger.info("Agent run completed via Quick sync fast-path", {
          runId: run.id,
          organisationId: input.organisationId,
          answerMode,
          deferred: deferHeavyBrief ? 1 : 0,
          research: quickResearchSync ? 1 : 0,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sync execute failed";
        logger.warn("Quick sync fast-path failed; retrying in-process (not queue)", {
          runId: run.id,
          message,
        });
        try {
          await executeAgentRun({
            organisationId: input.organisationId,
            runId: run.id,
          });
        } catch (retryError) {
          const retryMessage =
            retryError instanceof Error ? retryError.message : "Retry execute failed";
          logger.warn("Quick sync retry failed; writing honest PARTIAL (not enqueue)", {
            runId: run.id,
            message: retryMessage,
          });
          const salvaged = await salvageResearchPartialFromDb({
            organisationId: input.organisationId,
            agentRunId: run.id,
          }).catch(() => null);
          const raw = salvaged ?? honestEmptyResearchPartial(request);
          await updateOrgScopedById(prisma.agentRun, {
            id: run.id,
            organisationId: input.organisationId,
            extraWhere: { status: { in: ["PENDING", "PLANNING", "RUNNING"] } },
            data: {
              status: "PARTIAL",
              finishedAt: new Date(),
              error: "SYNC_EXECUTE_FAILED",
              finalOutput: attachVisibleResearchEvidence(raw) as Prisma.InputJsonValue,
              userFacingError: salvaged
                ? "I stopped before the full scan finished. Sources gathered so far are below."
                : "I couldn't finish that sourced scan in time. Nothing below was invented — try again in a moment.",
            },
          });
        }
      }
    };

    if (deferHeavyBrief) {
      const execPromise = runExecute();
      after(async () => {
        await execPromise;
      });
      return {
        runId: run.id,
        jobId: quickResearchSync ? `sync-quick-research:${run.id}` : `sync-quick-crm:${run.id}`,
        plainEnglishPlan: initialPlan,
        syncFastPath: true,
        acceptMs,
        answerMode: answerMode ?? null,
      };
    }

    await runExecute();
    const done = await prisma.agentRun.findFirst({
      where: { id: { equals: String(asSafePrismaId(run.id)) }, organisationId: { equals: String(asSafePrismaId(input.organisationId)) } },
      select: { status: true, finalOutput: true, plainEnglishPlan: true, totalCostCents: true },
    });
    return {
      runId: run.id,
      jobId: quickResearchSync ? `sync-quick-research:${run.id}` : `sync-quick-crm:${run.id}`,
      plainEnglishPlan: done?.plainEnglishPlan || initialPlan,
      syncFastPath: true,
      acceptMs,
      status: done?.status,
      finalOutput: done?.finalOutput ?? undefined,
      answerMode: answerMode ?? null,
      totalCostCents: done?.totalCostCents ?? 0,
      costNote: costNote(done?.totalCostCents ?? 0, done?.status),
    };
  }

  try {
    // DEEP: enqueue the Railway worker only when its heartbeat is fresh on this
    // Redis prefix. Preview used to force-queue all research; if Railway was
    // listening on prod prefix (or not running), jobs sat until after() reclaim
    // hit MAX_WALL_CLOCK with 0 steps. QUICK research never reaches this branch.
    const hostedWorkerLive = await isHostedWorkerLive();
    const preferDurableWorker = shouldEnqueueDurableAgentRun({
      inProcessSync: false,
      answerMode,
      looksLikeResearch: looksLikeResearch(request),
      hostedWorkerLive,
    });

    if (preferDurableWorker) {
      try {
        const { jobId } = await enqueueAgentRunJob({
          name: "agent-framework-run",
          organisationId: input.organisationId,
          payload: { agentRunId: run.id },
        });
        // Persist bullJobId + orphan reclaim off the accept path (one less DB RTT
        // before runId is returned to the client).
        after(async () => {
          try {
            await updateOrgScopedById(prisma.agentRun, {
              id: run.id,
              organisationId: input.organisationId,
              data: { bullJobId: jobId },
            });
          } catch (error) {
            logger.warn("Deferred bullJobId write failed", {
              runId: run.id,
              organisationId: input.organisationId,
              error: error instanceof Error ? error.message : "unknown",
            });
          }
          // Reclaim only true orphans. Never touch RUNNING — that races the Railway
          // worker and was resetting DEEP runs to PLANNING mid-flight.
          // First check at 8s so a missed enqueue can still finish inside the 30s
          // research ceiling. executeAgentRun claims PENDING/PLANNING only, so a
          // healthy worker that already moved the run to RUNNING wins.
          // First check at 2s for research so a missed pickup cannot burn the
          // 30s ceiling before any step runs (production: 0/1 steps, no tools).
          const delays = looksLikeResearchAsk ? [2_000, 8_000, 18_000] : [8_000, 20_000, 35_000];
          let waited = 0;
          for (const target of delays) {
            await new Promise((r) => setTimeout(r, target - waited));
            waited = target;
            const cur = await prisma.agentRun.findFirst({
              where: { id: { equals: String(asSafePrismaId(run.id)) }, organisationId: { equals: String(asSafePrismaId(input.organisationId)) } },
              select: {
                status: true,
                updatedAt: true,
                partialResults: true,
                _count: { select: { steps: true } },
              },
            });
            if (!cur) return;
            if (
              ["COMPLETED", "PARTIAL", "FAILED", "AWAITING_CLARIFICATION", "AWAITING_PROMPT_CONFIRM", "RUNNING"].includes(
                cur.status,
              )
            ) {
              return;
            }
            const pr =
              cur.partialResults && typeof cur.partialResults === "object"
                ? (cur.partialResults as { steps?: unknown[] })
                : null;
            const hasSteps =
              cur._count.steps > 0 || (Array.isArray(pr?.steps) && pr!.steps!.length > 0);
            if (hasSteps) return;
            const staleMs = Date.now() - cur.updatedAt.getTime();
            const reclaim =
              cur.status === "PENDING" ||
              (cur.status === "PLANNING" && staleMs >= 40_000);
            if (!reclaim) continue;
            try {
              await executeAgentRun({
                organisationId: input.organisationId,
                runId: run.id,
              });
            } catch (error) {
              logger.warn("Ask after() reclaim execute failed", {
                runId: run.id,
                organisationId: input.organisationId,
                error: error instanceof Error ? error.message : "unknown",
              });
            }
            return;
          }
        });
        acceptMs = Date.now() - acceptStarted;
        return {
          runId: run.id,
          jobId,
          plainEnglishPlan: initialPlan,
          syncFastPath: false,
          acceptMs,
          answerMode: answerMode ?? null,
        };
      } catch (enqueueError) {
        const enqueueMessage =
          enqueueError instanceof Error ? enqueueError.message : "Enqueue failed";
        logger.warn("Durable worker enqueue failed — falling back to local after()", {
          runId: run.id,
          organisationId: input.organisationId,
          error: enqueueMessage,
        });
        const runLocal = async () => {
          try {
            await executeAgentRun({
              organisationId: input.organisationId,
              runId: run.id,
            });
            await updateOrgScopedById(prisma.agentRun, {
              id: run.id,
              organisationId: input.organisationId,
              extraWhere: { bullJobId: null },
              data: { bullJobId: `sync-deep-local:${run.id}` },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Execute failed";
            logger.error("Local deep/research execute failed", {
              runId: run.id,
              organisationId: input.organisationId,
              error: message,
            });
            await updateOrgScopedById(prisma.agentRun, {
              id: run.id,
              organisationId: input.organisationId,
              data: {
                status: "FAILED",
                finishedAt: new Date(),
                error: message,
                userFacingError:
                  "I couldn't finish that request. Please try again in a moment.",
              },
            });
          }
        };
        const execPromise = runLocal();
        after(async () => {
          await execPromise;
        });
        acceptMs = Date.now() - acceptStarted;
        return {
          runId: run.id,
          jobId: `sync-deep-local:${run.id}`,
          plainEnglishPlan: initialPlan,
          syncFastPath: true,
          acceptMs,
          answerMode: answerMode ?? null,
        };
      }
    }

    // Worker heartbeat stale or this path is not DEEP-durable: execute locally
    // via after() so queue wait cannot burn the wall-clock with 0 steps.
    logger.warn("Ask running locally — hosted worker not live or not required", {
      runId: run.id,
      organisationId: input.organisationId,
      hostedWorkerLive,
      answerMode,
    });
    const runLocal = async () => {
      try {
        await executeAgentRun({
          organisationId: input.organisationId,
          runId: run.id,
        });
        await updateOrgScopedById(prisma.agentRun, {
          id: run.id,
          organisationId: input.organisationId,
          extraWhere: { bullJobId: null },
          data: { bullJobId: `sync-local:${run.id}` },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Execute failed";
        logger.error("Local agent-run execute failed", {
          runId: run.id,
          organisationId: input.organisationId,
          error: message,
        });
        await updateOrgScopedById(prisma.agentRun, {
          id: run.id,
          organisationId: input.organisationId,
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: message,
            userFacingError:
              "I couldn't finish that request. Please try again in a moment.",
          },
        });
      }
    };
    const execPromise = runLocal();
    after(async () => {
      await execPromise;
    });
    acceptMs = Date.now() - acceptStarted;
    return {
      runId: run.id,
      jobId: `sync-local:${run.id}`,
      plainEnglishPlan: initialPlan,
      syncFastPath: true,
      acceptMs,
      answerMode: answerMode ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Enqueue failed";
    await updateOrgScopedById(prisma.agentRun, {
              id: run.id,
              organisationId: input.organisationId,
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
    where: { id: { equals: String(asSafePrismaId(input.runId)) }, organisationId: { equals: String(asSafePrismaId(input.organisationId)) }, status: "AWAITING_CLARIFICATION" },
  });
  if (!run) {
    throw new Error("Run not awaiting clarification");
  }

  const options = parseOptions(run.clarificationOptions) || [];
  if (!options.includes(input.selectedOption)) {
    throw new Error("Invalid clarification option");
  }

  const formatMode = answerModeFromFormatOption(input.selectedOption);
  // Keep the immutable customer question — never append `[User chose: …]` into
  // request/topic/prompt content. Format options only update answerMode.
  // Intent options (Research / Social listening / …) rewrite the verb prefix only.
  let immutableRequest = stripClarificationMetadata(run.request);
  const option = input.selectedOption.trim();
  if (!formatMode) {
    if (/^research this topic with sources$/i.test(option)) {
      if (!/\b(research|look up|find out|investigate)\b/i.test(immutableRequest)) {
        immutableRequest = `Research ${immutableRequest}`.trim();
      }
    } else if (/^social listening on (this topic|a niche)$/i.test(option)) {
      if (!/\bsocial listening\b/i.test(immutableRequest)) {
        immutableRequest = `Social listening on ${immutableRequest}`.trim();
      }
    } else if (/^summarise it into a short brief$/i.test(option)) {
      if (!/\b(summaris|summariz)\b/i.test(immutableRequest)) {
        immutableRequest = `Summarise: ${immutableRequest}`.trim();
      }
    } else if (/^repeat it back to me$/i.test(option)) {
      if (!/\b(echo|repeat|say back)\b/i.test(immutableRequest)) {
        immutableRequest = `Echo: ${immutableRequest}`.trim();
      }
    }
  }
  const preservedMode = formatMode ?? run.answerMode ?? null;

  const priorBrief =
    run.pendingBrief && typeof run.pendingBrief === "object" && !Array.isArray(run.pendingBrief)
      ? (run.pendingBrief as Record<string, unknown>)
      : {};
  const originalUserPrompt =
    typeof priorBrief.originalUserPrompt === "string" && priorBrief.originalUserPrompt.trim()
      ? priorBrief.originalUserPrompt
      : stripClarificationMetadata(run.request);
  const priorClarifications = Array.isArray(priorBrief.clarifications)
    ? priorBrief.clarifications.filter((c): c is string => typeof c === "string")
    : [];

  await updateOrgScopedById(prisma.agentRun, {
              id: run.id,
              organisationId: input.organisationId,
              data: {
      request: immutableRequest,
      status: "PENDING",
      startedAt: new Date(),
      answerMode: preservedMode,
      ...(isQuickResearchAsk(preservedMode, immutableRequest)
        ? { maxWallClockSeconds: researchWallClockCapSeconds("QUICK") }
        : {}),
      clarificationQuestion: null,
      clarificationOptions: Prisma.DbNull,
      plan: Prisma.DbNull,
      plainEnglishPlan: isQuickResearchAsk(preservedMode, immutableRequest)
        ? `I'll do a fast sourced scan of “${immutableRequest.slice(0, 80)}” and give you a short answer.`
        : null,
      error: null,
      userFacingError: null,
      finishedAt: null,
      pendingBrief: {
        ...priorBrief,
        originalUserPrompt,
        clarifications: [...priorClarifications, input.selectedOption].slice(0, 20),
        answerMode: preservedMode,
      } as Prisma.InputJsonValue,
    },
  });

  if (isQuickResearchAsk(preservedMode, immutableRequest)) {
    try {
      await executeAgentRun({
        organisationId: input.organisationId,
        runId: run.id,
      });
      await updateOrgScopedById(prisma.agentRun, {
        id: run.id,
        organisationId: input.organisationId,
        data: { bullJobId: `sync-quick-research:${run.id}` },
      });
      return { runId: run.id, jobId: `sync-quick-research:${run.id}` };
    } catch (error) {
      logger.warn("Quick research clarify sync failed; retrying in-process (not queue)", {
        runId: run.id,
        message: error instanceof Error ? error.message : "unknown",
      });
      try {
        await executeAgentRun({
          organisationId: input.organisationId,
          runId: run.id,
        });
        await updateOrgScopedById(prisma.agentRun, {
          id: run.id,
          organisationId: input.organisationId,
          data: { bullJobId: `sync-quick-research:${run.id}` },
        });
        return { runId: run.id, jobId: `sync-quick-research:${run.id}` };
      } catch (retryError) {
        logger.warn("Quick research clarify retry failed; writing honest PARTIAL", {
          runId: run.id,
          message: retryError instanceof Error ? retryError.message : "unknown",
        });
        const salvaged = await salvageResearchPartialFromDb({
          organisationId: input.organisationId,
          agentRunId: run.id,
        }).catch(() => null);
        const raw = salvaged ?? honestEmptyResearchPartial(immutableRequest);
        await updateOrgScopedById(prisma.agentRun, {
          id: run.id,
          organisationId: input.organisationId,
          extraWhere: { status: { in: ["PENDING", "PLANNING", "RUNNING"] } },
          data: {
            status: "PARTIAL",
            finishedAt: new Date(),
            error: "SYNC_EXECUTE_FAILED",
            finalOutput: attachVisibleResearchEvidence(raw) as Prisma.InputJsonValue,
            userFacingError: salvaged
              ? "I stopped before the full scan finished. Sources gathered so far are below."
              : "I couldn't finish that sourced scan in time. Nothing below was invented — try again in a moment.",
          },
        });
        return { runId: run.id, jobId: `sync-quick-research:${run.id}` };
      }
    }
  }

  const { jobId } = await enqueueAgentRunJob({
    name: "agent-framework-run",
    organisationId: input.organisationId,
    payload: { agentRunId: run.id },
  });

  await updateOrgScopedById(prisma.agentRun, {
              id: run.id,
              organisationId: input.organisationId,
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
    where: { id: { equals: String(asSafePrismaId(input.runId)) }, organisationId: { equals: String(asSafePrismaId(input.organisationId)) }, status: "AWAITING_PROMPT_CONFIRM" },
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

  await updateOrgScopedById(prisma.agentRun, {
              id: run.id,
              organisationId: input.organisationId,
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

  await updateOrgScopedById(prisma.agentRun, {
              id: run.id,
              organisationId: input.organisationId,
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
    where: { id: { equals: String(asSafePrismaId(input.runId)) }, organisationId: { equals: String(asSafePrismaId(input.organisationId)) } },
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

  const progressLatency = (() => {
    const pr = run.partialResults;
    if (!pr || typeof pr !== "object" || Array.isArray(pr)) return null;
    const lt = (pr as { latencyTrace?: unknown }).latencyTrace;
    if (!lt || typeof lt !== "object" || Array.isArray(lt)) return null;
    return lt as Record<string, unknown>;
  })();
  const pickupAt =
    typeof progressLatency?.workerPickupAt === "number" &&
    Number.isFinite(progressLatency.workerPickupAt)
      ? progressLatency.workerPickupAt
      : null;
  const started = pickupAt ?? run.startedAt?.getTime() ?? run.createdAt.getTime();
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

  let finalOutput: unknown = run.finalOutput;
  let userFacingError = run.userFacingError;
  if (looksLikeResearch(run.request)) {
    const hydrated = await hydrateBlankResearchFinalOutput({
      organisationId: input.organisationId,
      agentRunId: run.id,
      request: run.request,
      status: run.status,
      finalOutput: run.finalOutput,
      lastCompletedOutput,
    });
    finalOutput = hydrated.finalOutput;
    if (
      hydrated.salvaged &&
      typeof userFacingError === "string" &&
      /finished 0 of/i.test(userFacingError)
    ) {
      userFacingError =
        "I stopped because this was taking too long. Sources gathered before the limit are below.";
    }
  }

  const displayOutput = finalOutput ?? lastCompletedOutput;
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
    costNote: costNote(run.totalCostCents, run.status),
    outputSoFar: lastCompletedOutput,
    finalOutput,
    userFacingError,
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
      toolsInvoked: toolsInvoked.map((t) => ({
        ...t,
        toolName: t.toolName.replace(/\btavily\b/gi, "web").replace(/\bexa\b/gi, "web"),
        error: t.error && /tavily|exa|apify|prisma|openai|anthropic|claude/i.test(t.error)
          ? "Tool call did not complete."
          : t.error,
      })),
      registeredTools: [],
      knowledgeUsed,
      memoryUsed,
    },
    latencyTrace: (() => {
      const pr = run.partialResults;
      if (!pr || typeof pr !== "object" || Array.isArray(pr)) return null;
      const lt = (pr as { latencyTrace?: unknown }).latencyTrace;
      if (!lt || typeof lt !== "object" || Array.isArray(lt)) return null;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(lt as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return Object.keys(out).length ? out : null;
    })(),
  };
}
