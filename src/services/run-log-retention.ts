/**
 * Retention for high-volume worker bookkeeping tables.
 *
 * - OpportunityDetectorRun  — rows with startedAt older than the cutoff
 * - ContinuousCollectionRun — rows with createdAt older than the cutoff
 *
 * Optional one-off (script only, never scheduled): SocialMetricSnapshot rows that the
 * old continuous-intelligence sweep produced by re-copying the latest snapshot
 * (raw.sweepSource = "SocialMetricSnapshot"). Each is a metric-for-metric duplicate of
 * an earlier snapshot of the same content, so deleting them loses no observations.
 *
 * Deletes run in small id batches (short locks, bounded WAL per statement).
 * Nothing here runs automatically unless RUN_LOG_RETENTION_ENABLED=true is set on the
 * worker; `scripts/prune-run-logs.ts` is dry-run unless passed --execute.
 */

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export const RUN_LOG_RETENTION_DEFAULT_DAYS = 30;
const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_MAX_BATCHES = 20;
const BATCH_PAUSE_MS = 250;

export type PruneTableResult = {
  /** Rows matching the cutoff (only computed in dry-run mode). */
  matched: number | null;
  deleted: number;
  batches: number;
  /** True when maxBatches stopped the loop before the backlog was empty. */
  truncated: boolean;
};

export type PruneRunLogsResult = {
  dryRun: boolean;
  cutoff: string;
  opportunityDetectorRun: PruneTableResult;
  continuousCollectionRun: PruneTableResult;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteInBatches(
  deleteBatch: (batchSize: number) => Promise<number>,
  batchSize: number,
  maxBatches: number,
): Promise<PruneTableResult> {
  let deleted = 0;
  let batches = 0;
  let truncated = false;
  for (;;) {
    if (batches >= maxBatches) {
      truncated = true;
      break;
    }
    const n = await deleteBatch(batchSize);
    batches += 1;
    deleted += n;
    if (n < batchSize) break;
    await sleep(BATCH_PAUSE_MS);
  }
  return { matched: null, deleted, batches, truncated };
}

/**
 * Delete OpportunityDetectorRun / ContinuousCollectionRun rows older than
 * `retentionDays` (default 30). Dry-run only counts.
 */
export async function pruneRunLogs(
  options: {
    retentionDays?: number;
    batchSize?: number;
    maxBatches?: number;
    dryRun?: boolean;
  } = {},
): Promise<PruneRunLogsResult> {
  const retentionDays = Math.max(7, options.retentionDays ?? RUN_LOG_RETENTION_DEFAULT_DAYS);
  const batchSize = Math.max(100, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 50_000));
  const maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_MAX_BATCHES);
  const dryRun = options.dryRun ?? false;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000);

  if (dryRun) {
    const [odr, ccr] = await Promise.all([
      prisma.opportunityDetectorRun.count({ where: { startedAt: { lt: cutoff } } }),
      prisma.continuousCollectionRun.count({ where: { createdAt: { lt: cutoff } } }),
    ]);
    const empty = { deleted: 0, batches: 0, truncated: false };
    return {
      dryRun,
      cutoff: cutoff.toISOString(),
      opportunityDetectorRun: { matched: odr, ...empty },
      continuousCollectionRun: { matched: ccr, ...empty },
    };
  }

  const opportunityDetectorRun = await deleteInBatches(
    (limit) => prisma.$executeRaw`
      DELETE FROM "OpportunityDetectorRun"
      WHERE "id" IN (
        SELECT "id" FROM "OpportunityDetectorRun"
        WHERE "startedAt" < ${cutoff}
        LIMIT ${limit}
      )
    `,
    batchSize,
    maxBatches,
  );

  const continuousCollectionRun = await deleteInBatches(
    (limit) => prisma.$executeRaw`
      DELETE FROM "ContinuousCollectionRun"
      WHERE "id" IN (
        SELECT "id" FROM "ContinuousCollectionRun"
        WHERE "createdAt" < ${cutoff}
        LIMIT ${limit}
      )
    `,
    batchSize,
    maxBatches,
  );

  const result: PruneRunLogsResult = {
    dryRun,
    cutoff: cutoff.toISOString(),
    opportunityDetectorRun,
    continuousCollectionRun,
  };
  logger.info("Run-log retention sweep complete", result);
  return result;
}

/**
 * One-off cleanup (script only): delete SocialMetricSnapshot rows that the old sweep
 * created by re-copying an existing snapshot (`raw.sweepSource = "SocialMetricSnapshot"`).
 */
export async function pruneSweepCopiedSnapshots(
  options: { batchSize?: number; maxBatches?: number; dryRun?: boolean } = {},
): Promise<PruneTableResult> {
  const batchSize = Math.max(100, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 50_000));
  const maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_MAX_BATCHES);

  if (options.dryRun) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM "SocialMetricSnapshot"
      WHERE "raw"->>'sweepSource' = 'SocialMetricSnapshot'
    `;
    return { matched: Number(rows[0]?.n ?? 0), deleted: 0, batches: 0, truncated: false };
  }

  return deleteInBatches(
    (limit) => prisma.$executeRaw`
      DELETE FROM "SocialMetricSnapshot"
      WHERE "id" IN (
        SELECT "id" FROM "SocialMetricSnapshot"
        WHERE "raw"->>'sweepSource' = 'SocialMetricSnapshot'
        LIMIT ${limit}
      )
    `,
    batchSize,
    maxBatches,
  );
}
