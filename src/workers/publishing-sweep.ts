/**
 * Phase 15 — Postgres sweep for due publishing jobs.
 * NO new BullMQ worker. Track 5 wires processDuePublishingJobs into workers/index.ts.
 */

import { MissionExternalOutcome, PublishingJobStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { dispatchPublishingJob } from "@/services/publishing/dispatch";

const DUE_STATUSES: PublishingJobStatus[] = [
  PublishingJobStatus.APPROVED,
  PublishingJobStatus.QUEUED,
  PublishingJobStatus.SCHEDULED,
];

export async function processDuePublishingJobs(limit = 20): Promise<{
  scanned: number;
  dispatched: number;
  failed: number;
  reconciliation: number;
}> {
  const now = new Date();
  const jobs = await prisma.publishingJob.findMany({
    where: {
      status: { in: DUE_STATUSES },
      externalOutcome: {
        notIn: [MissionExternalOutcome.CONFIRMED, MissionExternalOutcome.DISPATCHING],
      },
      OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
    },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
    take: Math.max(1, Math.min(limit, 100)),
    select: { id: true, organisationId: true },
  });

  let dispatched = 0;
  let failed = 0;
  let reconciliation = 0;

  for (const job of jobs) {
    try {
      const result = await dispatchPublishingJob({
        organisationId: job.organisationId,
        jobId: job.id,
        now,
      });
      if (result.ok && result.claimed) {
        dispatched += 1;
      } else if (
        result.externalOutcome === MissionExternalOutcome.RECONCILIATION_REQUIRED &&
        result.claimed
      ) {
        reconciliation += 1;
      } else if (!result.ok && result.claimed) {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      logger.error("Publishing dispatch failed", {
        jobId: job.id,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  if (jobs.length > 0) {
    logger.info("Publishing sweep complete", {
      scanned: jobs.length,
      dispatched,
      failed,
      reconciliation,
    });
  }

  return { scanned: jobs.length, dispatched, failed, reconciliation };
}
