/**
 * Standalone BullMQ worker entry point.
 *
 * Deploy this process separately from Next.js (Railway / Render / Fly).
 * It shares Prisma + services via the same source tree — do not fork.
 *
 *   npm run worker
 *
 * Queues:
 *   - follow-ups   (short sweeps)
 *   - agent-runs   (long jobs; concurrency limited; long lock duration)
 *   - maintenance  (retention + embedding backfill)
 *
 * Production: REDIS_URL required. In-process fallback is local/dev only.
 */
import { Worker } from "bullmq";
import {
  AGENT_RUN_CONCURRENCY,
  AGENT_RUN_LOCK_DURATION_MS,
  QUEUE_AGENT_RUNS,
  QUEUE_FOLLOW_UPS,
  QUEUE_MAINTENANCE,
  closeQueues,
} from "@/jobs/queues";
import {
  assertRedisAllowedFallback,
  closeRedisConnection,
  getRedisConnection,
  pingRedis,
  redisRequired,
} from "@/jobs/redis";
import { enqueueAgentRetentionSweep } from "@/jobs/maintenance";
import { processDueFollowUps, startInProcessFollowUpLoop } from "@/workers/followups";
import { processAgentRunJob } from "@/workers/agent-runs-processor";
import { processMaintenanceJob } from "@/workers/maintenance-processor";
import { aggregateDailyInsights } from "@/services/insights-aggregation";
import { pruneAgentArtifactsAllOrganisations } from "@/services/agent-retention";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordFailedJob } from "@/services/failed-jobs";
import { assertProductionSecretsConfigured } from "@/lib/env";

try {
  assertProductionSecretsConfigured();
} catch (error) {
  logger.error("Worker refused to start — production secrets not configured", {
    message: error instanceof Error ? error.message : "unknown",
  });
  process.exit(1);
}

const workers: Worker[] = [];
const intervals: NodeJS.Timeout[] = [];
let shuttingDown = false;

async function runDailyAggregationSweep() {
  const orgs = await prisma.organisation.findMany({
    where: { deletedAt: null, isPlatform: false },
    select: { id: true },
    take: 200,
  });
  const today = new Date();
  for (const org of orgs) {
    await aggregateDailyInsights(org.id, today);
  }
  logger.info("Daily insights aggregation sweep complete", { orgs: orgs.length });
}

async function startRedisWorkers() {
  const connection = getRedisConnection();

  const followUpWorker = new Worker(
    QUEUE_FOLLOW_UPS,
    async () => {
      const sent = await processDueFollowUps();
      return { sent };
    },
    { connection, concurrency: 1 },
  );

  const agentRunsWorker = new Worker(QUEUE_AGENT_RUNS, processAgentRunJob, {
    connection,
    concurrency: AGENT_RUN_CONCURRENCY,
    lockDuration: AGENT_RUN_LOCK_DURATION_MS,
    stalledInterval: 60_000,
    maxStalledCount: 2,
  });

  const maintenanceWorker = new Worker(QUEUE_MAINTENANCE, processMaintenanceJob, {
    connection,
    concurrency: 1,
  });

  workers.push(followUpWorker, agentRunsWorker, maintenanceWorker);

  followUpWorker.on("ready", () => logger.info("BullMQ follow-ups worker ready"));
  agentRunsWorker.on("ready", () =>
    logger.info("BullMQ agent-runs worker ready", {
      concurrency: AGENT_RUN_CONCURRENCY,
      lockDurationMs: AGENT_RUN_LOCK_DURATION_MS,
    }),
  );
  maintenanceWorker.on("ready", () =>
    logger.info("BullMQ maintenance worker ready (retention + embedding backfill)"),
  );

  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      logger.error("Worker job failed", {
        queue: worker.name,
        jobId: job?.id,
        jobName: job?.name,
        message: err.message,
      });
      void recordFailedJob({
        organisationId:
          typeof job?.data?.organisationId === "string" ? job.data.organisationId : null,
        queue: worker.name,
        jobName: job?.name || "unknown",
        payload: { jobId: job?.id, data: job?.data },
        error: err.message,
        attempts: job?.attemptsMade,
      });
    });
    worker.on("completed", (job) => {
      logger.info("Worker job completed", {
        queue: worker.name,
        jobId: job.id,
        jobName: job.name,
      });
    });
  }

  intervals.push(
    setInterval(() => {
      processDueFollowUps().catch((error) =>
        logger.error("Scheduled follow-up sweep failed", {
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }, 60_000),
  );

  intervals.push(
    setInterval(() => {
      runDailyAggregationSweep().catch((error) =>
        logger.error("Daily insights sweep failed", {
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }, 60 * 60_000),
  );

  intervals.push(
    setInterval(() => {
      pruneAgentArtifactsAllOrganisations().catch((error) =>
        logger.error("Agent retention sweep failed", {
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }, 60 * 60_000),
  );

  await enqueueAgentRetentionSweep({ schedule: true });
  runDailyAggregationSweep().catch(() => undefined);
  pruneAgentArtifactsAllOrganisations().catch(() => undefined);
  logger.info("Worker started with Redis (follow-ups + agent-runs + maintenance)");
}

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal} — draining workers (finish or requeue in-flight jobs)`);

  for (const timer of intervals) clearInterval(timer);

  await Promise.all(
    workers.map(async (worker) => {
      try {
        await worker.close();
        logger.info("Worker closed", { queue: worker.name });
      } catch (error) {
        logger.error("Worker close failed", {
          queue: worker.name,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }),
  );

  await closeQueues();
  await closeRedisConnection();
  await prisma.$disconnect().catch(() => undefined);
  logger.info("Worker shutdown complete");
  process.exit(0);
}

async function main() {
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

  const redisOk = await pingRedis();
  if (redisOk) {
    await startRedisWorkers();
    return;
  }

  if (redisRequired()) {
    logger.error("Redis is REQUIRED in production and is unavailable — exiting");
    process.exit(1);
  }

  assertRedisAllowedFallback();
  startInProcessFollowUpLoop(60_000);
  intervals.push(
    setInterval(() => {
      runDailyAggregationSweep().catch(() => undefined);
    }, 60 * 60_000),
  );
  intervals.push(
    setInterval(() => {
      pruneAgentArtifactsAllOrganisations().catch(() => undefined);
    }, 60 * 60_000),
  );
  logger.error(
    "⚠️  Worker running WITHOUT Redis — agent-runs and maintenance queues are inactive. " +
      "Start Redis and restart this process before testing long jobs or retention.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
