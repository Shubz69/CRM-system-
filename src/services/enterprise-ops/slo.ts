/**
 * Phase 18 — Operational SLO snapshots.
 * MaturityNote is always FOUNDATION — no contractual SLO claims.
 */

import {
  DomainEventStatus,
  MissionStatus,
  Prisma,
  PublishingJobStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { pingRedis } from "@/jobs/redis";

export const SLO_MATURITY_NOTE = "FOUNDATION" as const;

export type SloIndicators = {
  capturedAt: string;
  workerFreshness: {
    /** Newest AgentRun finishedAt age in ms; null if none */
    lastAgentRunFinishedAgeMs: number | null;
    redisReachable: boolean | null;
    note: string;
  };
  outboxLag: {
    pendingCount: number;
    retryCount: number;
    deadLetterCount: number;
    /** Age of oldest pending/retry availableAt in ms; null if none */
    oldestPendingAgeMs: number | null;
    note: string;
  };
  publishSuccessRate: {
    /** Null when no terminal publish jobs in window */
    rate: number | null;
    publishedCount: number;
    failedCount: number;
    windowHours: number;
    note: string;
  };
  continuousIntelRuns: {
    count: number;
    windowHours: number;
    note: string;
  };
  publishingDispatching: {
    count: number;
    note: string;
  };
  missionWaitingApproval: {
    count: number;
    note: string;
  };
};

async function buildIndicators(organisationId?: string | null): Promise<SloIndicators> {
  const now = new Date();
  const whereOrg = organisationId ? { organisationId } : {};
  const windowHours = 24;
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const [
    lastRun,
    redisOk,
    pending,
    retry,
    deadLetter,
    oldestPending,
    publishedCount,
    failedCount,
    continuousIntelRuns,
    publishingDispatching,
    missionWaitingApproval,
  ] = await Promise.all([
    prisma.agentRun.findFirst({
      where: {
        ...whereOrg,
        finishedAt: { not: null },
      },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    pingRedis().catch(() => null as boolean | null),
    prisma.domainEvent.count({
      where: { ...whereOrg, status: DomainEventStatus.PENDING },
    }),
    prisma.domainEvent.count({
      where: { ...whereOrg, status: DomainEventStatus.RETRY },
    }),
    prisma.domainEvent.count({
      where: { ...whereOrg, status: DomainEventStatus.DEAD_LETTER },
    }),
    prisma.domainEvent.findFirst({
      where: {
        ...whereOrg,
        status: { in: [DomainEventStatus.PENDING, DomainEventStatus.RETRY] },
      },
      orderBy: { availableAt: "asc" },
      select: { availableAt: true },
    }),
    prisma.publishingJob.count({
      where: {
        ...whereOrg,
        status: PublishingJobStatus.PUBLISHED,
        updatedAt: { gte: since },
      },
    }),
    prisma.publishingJob.count({
      where: {
        ...whereOrg,
        status: PublishingJobStatus.FAILED,
        updatedAt: { gte: since },
      },
    }),
    prisma.continuousCollectionRun.count({
      where: {
        ...whereOrg,
        observedAt: { gte: since },
      },
    }),
    prisma.publishingJob.count({
      where: {
        ...whereOrg,
        status: PublishingJobStatus.DISPATCHING,
      },
    }),
    prisma.agentMission.count({
      where: {
        ...whereOrg,
        status: MissionStatus.WAITING_APPROVAL,
      },
    }),
  ]);

  const terminal = publishedCount + failedCount;
  const publishRate = terminal === 0 ? null : publishedCount / terminal;

  return {
    capturedAt: now.toISOString(),
    workerFreshness: {
      lastAgentRunFinishedAgeMs: lastRun?.finishedAt
        ? now.getTime() - lastRun.finishedAt.getTime()
        : null,
      redisReachable: redisOk,
      note: "Indicator only — not a contractual worker SLO.",
    },
    outboxLag: {
      pendingCount: pending,
      retryCount: retry,
      deadLetterCount: deadLetter,
      oldestPendingAgeMs: oldestPending?.availableAt
        ? now.getTime() - oldestPending.availableAt.getTime()
        : null,
      note: "DB count placeholders for lag — not a contractual latency SLO.",
    },
    publishSuccessRate: {
      rate: publishRate,
      publishedCount,
      failedCount,
      windowHours,
      note:
        publishRate == null
          ? "No terminal publish jobs in window — rate stays null (not invented)."
          : "Derived from PublishingJob statuses only — not a contractual publish SLO.",
    },
    continuousIntelRuns: {
      count: continuousIntelRuns,
      windowHours,
      note: "ContinuousCollectionRun count in window — FOUNDATION indicator.",
    },
    publishingDispatching: {
      count: publishingDispatching,
      note: "Jobs currently DISPATCHING — not a success rate.",
    },
    missionWaitingApproval: {
      count: missionWaitingApproval,
      note: "Missions in WAITING_APPROVAL — ops backlog indicator only.",
    },
  };
}

/**
 * Capture and persist OperationalSloSnapshot. Always FOUNDATION maturity.
 */
export async function captureOperationalSloSnapshot(input?: {
  organisationId?: string | null;
}) {
  const organisationId = input?.organisationId ?? null;
  const indicators = await buildIndicators(organisationId);

  const row = await prisma.operationalSloSnapshot.create({
    data: {
      organisationId,
      capturedAt: new Date(indicators.capturedAt),
      indicators: indicators as unknown as Prisma.InputJsonValue,
      maturityNote: SLO_MATURITY_NOTE,
    },
  });

  return {
    ...row,
    indicators,
    maturityNote: SLO_MATURITY_NOTE,
    contractualSlo: false as const,
  };
}

export async function getLatestOperationalSloSnapshot(organisationId?: string | null) {
  return prisma.operationalSloSnapshot.findFirst({
    where: organisationId != null ? { organisationId } : undefined,
    orderBy: { capturedAt: "desc" },
  });
}

/** Read-only build without persist — for admin UI. */
export async function peekSloIndicators(organisationId?: string | null) {
  return buildIndicators(organisationId);
}
