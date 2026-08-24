/**
 * Phase 10 — Chief of Staff briefing + AI Ops snapshots.
 * All counts from real tables; never invent success rates.
 *
 * Phase 18 — Enterprise ops panel (SLO FOUNDATION, cost/RBAC WORKING) via
 * `@/services/enterprise-ops`. No contractual SLO claims in customer UI.
 */

import { prisma } from "@/lib/db";
import { getQueuePrefix, pingRedis } from "@/jobs/redis";
import { getAgentRunsQueue } from "@/jobs/queues";
import { getEntitlementsDashboard } from "@/services/entitlements";
import { getQueueOpsSnapshot } from "@/services/queue-ops";
import { getOutboxOpsSnapshot } from "@/services/domain-events";
import { getIntegrationOpsForAiOps } from "@/services/connectors";
import { getEnterpriseOpsPanel } from "@/services/enterprise-ops";

/** Throttle Redis getJobCounts — do not hammer Redis for admin UI. */
let cachedAgentQueueCounts: {
  at: number;
  value: Awaited<ReturnType<typeof queueCountsSafe>>;
} | null = null;
const QUEUE_COUNTS_CACHE_MS = 30_000;

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
    const q = getQueue() as {
      getJobCounts: (...types: string[]) => Promise<Record<string, number>>;
    };
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
async function getAgentRunsCountsCached() {
  const now = Date.now();
  if (cachedAgentQueueCounts && now - cachedAgentQueueCounts.at < QUEUE_COUNTS_CACHE_MS) {
    return cachedAgentQueueCounts.value;
  }
  const value = await queueCountsSafe("agent-runs", () => getAgentRunsQueue() as never);
  cachedAgentQueueCounts = { at: now, value };
  return value;
}

export async function getAiOpsSnapshot(organisationId?: string) {
  const redisOk = await pingRedis().catch(() => false);
  const queueOps = getQueueOpsSnapshot();

  const failedWhere = organisationId
    ? { organisationId, resolvedAt: null }
    : { resolvedAt: null };

  const [openFailedJobs, recentFailedJobs, recentRuns, recentAiFailures, agentQueue, outbox, phase13Raw, phase14, enterpriseOps] =
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
      redisOk ? getAgentRunsCountsCached() : Promise.resolve(null),
      getOutboxOpsSnapshot(organisationId).catch(() => null),
      organisationId
        ? Promise.all([
            prisma.goal.count({ where: { organisationId } }),
            prisma.goal.count({ where: { organisationId, status: "AT_RISK" } }),
            prisma.businessOpportunity.groupBy({
              by: ["status"],
              where: { organisationId },
              _count: { _all: true },
            }),
            prisma.opportunityDetectorRun.findMany({
              where: { organisationId },
              orderBy: { startedAt: "desc" },
              take: 10,
              select: {
                detectorKey: true,
                createdCount: true,
                updatedCount: true,
                suppressedCount: true,
                errorSummary: true,
                startedAt: true,
                finishedAt: true,
              },
            }),
          ]).catch(() => null)
        : Promise.resolve(null),
      getIntegrationOpsForAiOps(organisationId).catch(() => null),
      getEnterpriseOpsPanel(organisationId).catch(() => null),
    ]);

  const phase13 = phase13Raw
    ? {
        goalsTotal: phase13Raw[0],
        goalsAtRisk: phase13Raw[1],
        opportunitiesByStatus: Object.fromEntries(
          phase13Raw[2].map((r) => [r.status, r._count._all]),
        ),
        recentDetectorRuns: phase13Raw[3],
      }
    : null;

  return {
    redisOk,
    queuePrefix: getQueuePrefix(),
    workerRequiredForAsk: true,
    openFailedJobs,
    recentFailedJobs,
    recentRuns,
    recentAiFailures,
    /** Single BullMQ queue — follow-ups/retention/outbox are Postgres sweeps. */
    queues: agentQueue ? [agentQueue] : [],
    queueOps,
    outbox,
    phase13,
    phase14,
    /** Phase 18 — SLO FOUNDATION; publish health from real job counts only */
    enterpriseOps,
    topology: {
      bullmqWorkers: 1,
      authoritativeFollowUps: "worker-postgres-interval",
      authoritativeRetention: "worker-postgres-interval",
      authoritativeOutbox: "worker-postgres-interval",
      authoritativeOpportunityDetectors: "worker-postgres-interval",
      connectorMesh: "postgres-capability-eval",
      cronFallback: "CRON_FALLBACK_ENABLED only",
    },
    message: redisOk
      ? "Redis reachable — confirm hosted worker (npm run worker). Follow-ups/retention/outbox/detectors do not poll Redis."
      : "Redis down — Ask agent-runs will not process until Redis + worker are healthy. Durable state + outbox remain in Postgres.",
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

/** Phase 18 enterprise-ops re-exports */
export {
  captureOperationalSloSnapshot,
  peekSloIndicators,
  recordCostOutcomeLink,
  getEnterpriseOpsPanel,
  getSsoScimReadiness,
  dryRunRetentionPurge,
  getRbacMatrixDocumentation,
  SLO_MATURITY_NOTE,
  SSO_SCIM_MATURITY,
} from "@/services/enterprise-ops";

