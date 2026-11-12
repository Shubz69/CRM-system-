/**
 * Prune high-volume worker bookkeeping rows. DRY RUN unless --execute is passed.
 *
 *   npx tsx scripts/prune-run-logs.ts                 # counts only
 *   npx tsx scripts/prune-run-logs.ts --days=30 --execute
 *   npx tsx scripts/prune-run-logs.ts --dedupe-sweep-snapshots            # count copies
 *   npx tsx scripts/prune-run-logs.ts --dedupe-sweep-snapshots --execute  # delete copies
 *
 * What --execute deletes (in 5k-row batches, max --max-batches per table per run):
 *   - OpportunityDetectorRun  WHERE startedAt < now() - days
 *   - ContinuousCollectionRun WHERE createdAt < now() - days
 *   - with --dedupe-sweep-snapshots additionally: SocialMetricSnapshot rows whose
 *     raw.sweepSource = 'SocialMetricSnapshot' (exact metric copies the old sweep made)
 *
 * Deleting rows does not shrink the table files; run VACUUM (or pg_repack /
 * VACUUM FULL in a maintenance window) afterwards to reclaim disk.
 * Never prints credentials. Get the owner's go-ahead before --execute on production.
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import {
  pruneRunLogs,
  pruneSweepCopiedSnapshots,
  RUN_LOG_RETENTION_DEFAULT_DAYS,
} from "@/services/run-log-retention";

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const dedupe = process.argv.includes("--dedupe-sweep-snapshots");
  const days = Number(argValue("days") || RUN_LOG_RETENTION_DEFAULT_DAYS);
  const maxBatches = Number(argValue("max-batches") || 1_000);

  console.log(execute ? "MODE=EXECUTE (deleting)" : "MODE=DRY_RUN (no deletes)");

  if (dedupe) {
    const result = await pruneSweepCopiedSnapshots({ dryRun: !execute, maxBatches });
    console.log(JSON.stringify({ sweepCopiedSnapshots: result }, null, 2));
    return;
  }

  const result = await pruneRunLogs({ retentionDays: days, dryRun: !execute, maxBatches });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));
