/**
 * Phase 18 — Production health indicators (FOUNDATION maturity).
 * Checks local infra only — never calls paid providers.
 */

import { DomainEventStatus, PublishingJobStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { pingRedis } from "@/jobs/redis";
import { getRedisCircuitSnapshot, isRedisCircuitOpen } from "@/jobs/redis-circuit";

export const PRODUCTION_HEALTH_MATURITY = "FOUNDATION" as const;

export type ProductionHealth = {
  maturity: typeof PRODUCTION_HEALTH_MATURITY;
  capturedAt: string;
  ok: boolean;
  database: { ok: boolean; detail: string };
  redis: { ok: boolean; detail: string };
  outboxLag: {
    pendingCount: number;
    retryCount: number;
    deadLetterCount: number;
    oldestPendingAgeMs: number | null;
  };
  workerHeartbeat: {
    newestAgentRunFinishedAt: string | null;
    ageMs: number | null;
    note: string;
  };
  publishing: {
    reconciliationRequiredCount: number;
  };
  note: string;
};

/**
 * Aggregate production health — DB, Redis, outbox lag, AgentRun heartbeat, publish reconcile.
 * Does not call paid AI / social providers.
 */
export async function getProductionHealth(): Promise<ProductionHealth> {
  const now = new Date();
  let databaseOk = false;
  let databaseDetail = "down";
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseOk = true;
    databaseDetail = "SELECT 1 ok";
  } catch (error) {
    databaseDetail =
      error instanceof Error ? error.message.slice(0, 200) : "query failed";
  }

  let redisOk = false;
  try {
    redisOk = await pingRedis();
  } catch {
    redisOk = false;
  }
  const circuit = getRedisCircuitSnapshot();
  const redisDetail = isRedisCircuitOpen()
    ? `provider circuit OPEN (${circuit.openReason ?? "fatal"})`
    : redisOk
      ? "ping ok"
      : "unreachable or not configured";

  let pending = 0;
  let retry = 0;
  let deadLetter = 0;
  let oldestPendingAgeMs: number | null = null;
  let newestAgentRunFinishedAt: string | null = null;
  let ageMs: number | null = null;
  let reconciliationRequired = 0;

  if (databaseOk) {
    try {
      const [pendingC, retryC, deadC, oldestPending, lastRun, reconC] =
        await Promise.all([
          prisma.domainEvent.count({ where: { status: DomainEventStatus.PENDING } }),
          prisma.domainEvent.count({ where: { status: DomainEventStatus.RETRY } }),
          prisma.domainEvent.count({
            where: { status: DomainEventStatus.DEAD_LETTER },
          }),
          prisma.domainEvent.findFirst({
            where: {
              status: { in: [DomainEventStatus.PENDING, DomainEventStatus.RETRY] },
            },
            orderBy: { availableAt: "asc" },
            select: { availableAt: true },
          }),
          prisma.agentRun.findFirst({
            where: { finishedAt: { not: null } },
            orderBy: { finishedAt: "desc" },
            select: { finishedAt: true },
          }),
          prisma.publishingJob.count({
            where: { status: PublishingJobStatus.RECONCILIATION_REQUIRED },
          }),
        ]);
      pending = pendingC;
      retry = retryC;
      deadLetter = deadC;
      oldestPendingAgeMs = oldestPending?.availableAt
        ? now.getTime() - oldestPending.availableAt.getTime()
        : null;
      newestAgentRunFinishedAt = lastRun?.finishedAt?.toISOString() ?? null;
      ageMs = lastRun?.finishedAt
        ? now.getTime() - lastRun.finishedAt.getTime()
        : null;
      reconciliationRequired = reconC;
    } catch {
      databaseOk = false;
      databaseDetail = "SELECT 1 ok but follow-up counts failed";
    }
  }

  return {
    maturity: PRODUCTION_HEALTH_MATURITY,
    capturedAt: now.toISOString(),
    ok: databaseOk,
    database: { ok: databaseOk, detail: databaseDetail },
    redis: {
      ok: redisOk && !isRedisCircuitOpen(),
      detail: redisDetail,
    },
    outboxLag: {
      pendingCount: pending,
      retryCount: retry,
      deadLetterCount: deadLetter,
      oldestPendingAgeMs,
    },
    workerHeartbeat: {
      newestAgentRunFinishedAt,
      ageMs,
      note: "Derived from newest AgentRun.finishedAt — not a contractual SLA.",
    },
    publishing: {
      reconciliationRequiredCount: reconciliationRequired,
    },
    note: "FOUNDATION health indicators only — no paid provider probes.",
  };
}
