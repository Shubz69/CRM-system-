/**
 * Phase 10 — Chief of Staff briefing + AI Ops snapshots.
 * All counts from real tables; never invent success rates.
 */

import { prisma } from "@/lib/db";
import { pingRedis } from "@/jobs/redis";
import {
  getAgentRunsQueue,
  getFollowUpQueue,
  getMaintenanceQueue,
} from "@/jobs/queues";
import { getEntitlementsDashboard } from "@/services/entitlements";

export type BriefingItem = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
  severity: "high" | "medium" | "low";
};

/**
 * Compact executive briefing for Home — real attention signals only.
 */
export async function getChiefOfStaffBriefing(organisationId: string): Promise<{
  items: BriefingItem[];
  nextActions: Array<{ label: string; href: string }>;
  setupNeeded: boolean;
}> {
  const [
    handoffCount,
    hotLeadCount,
    openFailedJobs,
    knowledgeGaps,
    agentConfig,
    pendingApprovals,
  ] = await Promise.all([
    prisma.conversation.count({
      where: {
        organisationId,
        deletedAt: null,
        OR: [{ needsHumanReview: true }, { handlingMode: "HUMAN" }],
      },
    }),
    prisma.lead.count({
      where: { organisationId, deletedAt: null, score: { gte: 70 } },
    }),
    prisma.failedJob.count({
      where: { organisationId, resolvedAt: null },
    }),
    prisma.knowledgeRecommendation.count({
      where: { organisationId, status: "NEW" },
    }),
    prisma.agentConfiguration.findFirst({
      where: { organisationId, isActive: true },
      select: { id: true },
    }),
    prisma.approvalRequest.count({
      where: { organisationId, status: "PENDING" },
    }),
  ]);

  const items: BriefingItem[] = [];
  if (handoffCount > 0) {
    items.push({
      id: "handoffs",
      kind: "inbox",
      title: `${handoffCount} conversation${handoffCount === 1 ? "" : "s"} need a human`,
      detail: "Handoffs and review flags from live inbox data",
      href: "/attention",
      severity: "high",
    });
  }
  if (hotLeadCount > 0) {
    items.push({
      id: "hot_leads",
      kind: "pipeline",
      title: `${hotLeadCount} hot lead${hotLeadCount === 1 ? "" : "s"} (score ≥ 70)`,
      detail: "From current pipeline scores — not estimates",
      href: "/pipeline",
      severity: "medium",
    });
  }
  if (pendingApprovals > 0) {
    items.push({
      id: "approvals",
      kind: "automations",
      title: `${pendingApprovals} pending approval${pendingApprovals === 1 ? "" : "s"}`,
      detail: "Outbound / publish gates waiting on a decision",
      href: "/automations",
      severity: "high",
    });
  }
  if (knowledgeGaps > 0) {
    items.push({
      id: "knowledge",
      kind: "knowledge",
      title: `${knowledgeGaps} knowledge gap${knowledgeGaps === 1 ? "" : "s"} to review`,
      detail: "Recommendations stay draft until you approve",
      href: "/knowledge",
      severity: "low",
    });
  }
  if (openFailedJobs > 0) {
    items.push({
      id: "failed_jobs",
      kind: "ops",
      title: `${openFailedJobs} unresolved failed job${openFailedJobs === 1 ? "" : "s"}`,
      detail: "Background work that needs attention",
      href: "/attention",
      severity: "high",
    });
  }

  const setupNeeded = !agentConfig;
  const nextActions: Array<{ label: string; href: string }> = [];
  if (setupNeeded) {
    nextActions.push({ label: "Configure workspace with Setup Assistant", href: "/setup" });
  }
  if (handoffCount > 0) {
    nextActions.push({ label: "Open inbox handoffs", href: "/inbox" });
  }
  nextActions.push({ label: "Go-live checklist", href: "/settings/go-live" });
  if (nextActions.length < 3) {
    nextActions.push({ label: "Review needs attention", href: "/attention" });
  }

  return {
    items: items.slice(0, 6),
    nextActions: nextActions.slice(0, 3),
    setupNeeded,
  };
}

async function queueCountsSafe(name: string, getQueue: () => { getJobCounts: (...types: string[]) => Promise<Record<string, number>> }) {
  try {
    const q = getQueue();
    const counts = await q.getJobCounts("waiting", "active", "delayed", "failed");
    return {
      name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      ok: true as const,
    };
  } catch (e) {
    return {
      name,
      waiting: null,
      active: null,
      delayed: null,
      failed: null,
      ok: false as const,
      error: e instanceof Error ? e.message : "queue unavailable",
    };
  }
}

/**
 * Platform AI Ops snapshot — real FailedJob / AgentRun / queue depths only.
 */
export async function getAiOpsSnapshot(organisationId?: string) {
  const redisOk = await pingRedis().catch(() => false);

  const failedWhere = organisationId
    ? { organisationId, resolvedAt: null }
    : { resolvedAt: null };

  const [openFailedJobs, recentFailedJobs, recentRuns, recentAiFailures, queues] =
    await Promise.all([
      prisma.failedJob.count({ where: failedWhere }),
      prisma.failedJob.findMany({
        where: failedWhere,
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          organisationId: true,
          queue: true,
          jobName: true,
          error: true,
          createdAt: true,
        },
      }),
      prisma.agentRun.findMany({
        where: organisationId ? { organisationId } : undefined,
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          organisationId: true,
          status: true,
          request: true,
          totalCostCents: true,
          createdAt: true,
          finishedAt: true,
          userFacingError: true,
        },
      }),
      prisma.aiExecution.findMany({
        where: {
          success: false,
          ...(organisationId ? { organisationId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: {
          id: true,
          organisationId: true,
          provider: true,
          model: true,
          taskType: true,
          error: true,
          createdAt: true,
        },
      }),
      Promise.all([
        queueCountsSafe("follow-ups", getFollowUpQueue),
        queueCountsSafe("agent-runs", getAgentRunsQueue),
        queueCountsSafe("maintenance", getMaintenanceQueue),
      ]),
    ]);

  return {
    redisOk,
    workerRequiredForAsk: true,
    openFailedJobs,
    recentFailedJobs,
    recentRuns,
    recentAiFailures,
    queues,
    message: redisOk
      ? "Redis reachable — confirm a hosted worker process is running (npm run worker)."
      : "Redis down — Ask agent-runs will not process until Redis + worker are healthy.",
  };
}

export async function getWorkspaceOpsSummary(organisationId: string) {
  const [briefing, entitlements, aiOps] = await Promise.all([
    getChiefOfStaffBriefing(organisationId),
    getEntitlementsDashboard(organisationId),
    getAiOpsSnapshot(organisationId),
  ]);
  return { briefing, entitlements, aiOps };
}
