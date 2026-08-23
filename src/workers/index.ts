/**
 * Standalone BullMQ worker entry point.
 *
 * Deploy separately from Next.js (Railway / Render / Fly):
 *   npm run worker
 *
 * Topology (P0 Redis cost fix):
 *   - ONE BullMQ Worker: agent-runs (responsive long jobs + on-demand maintenance)
 *   - Follow-ups: Postgres sweep via setInterval (authoritative; no Redis)
 *   - Retention + daily insights: Postgres sweep hourly (authoritative; no Redis)
 *   - Vercel /api/cron: only when CRON_FALLBACK_ENABLED=true
 *
 * Redis coordinates agent-runs execution. Durable state lives in Postgres.
 */
import { Worker } from "bullmq";
import {
  AGENT_RUN_CONCURRENCY,
  AGENT_RUN_LOCK_DURATION_MS,
  AGENT_RUN_STALLED_INTERVAL_MS,
  QUEUE_AGENT_RUNS,
  closeQueues,
} from "@/jobs/queues";
import {
  assertRedisAllowedFallback,
  assertRedisUrlAllowedForRuntime,
  closeRedisConnection,
  cronFallbackEnabled,
  getBullMqPrefix,
  getQueuePrefix,
  getRedisConnection,
  pingRedis,
  redisRequired,
} from "@/jobs/redis";
import { processDueFollowUps, startInProcessFollowUpLoop } from "@/workers/followups";
import { processAgentRunJob } from "@/workers/agent-runs-processor";
import { aggregateDailyInsights } from "@/services/insights-aggregation";
import { pruneAgentArtifactsAllOrganisations } from "@/services/agent-retention";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordFailedJob } from "@/services/failed-jobs";
import { assertProductionSecretsConfigured } from "@/lib/env";
import {
  markWorkerStarted,
  markWorkerStopped,
  recordQueueOp,
} from "@/services/queue-ops";

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

const FOLLOW_UP_INTERVAL_MS = Number(process.env.FOLLOW_UP_SWEEP_INTERVAL_MS || 60_000);
const MAINTENANCE_INTERVAL_MS = Number(process.env.MAINTENANCE_SWEEP_INTERVAL_MS || 60 * 60_000);

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

/** Authoritative follow-up path: Postgres only (no Redis). */
function startFollowUpDbSweep() {
  intervals.push(
    setInterval(() => {
      processDueFollowUps()
        .then((sent) => {
          if (sent > 0) logger.info("Follow-up sweep sent", { sent });
        })
        .catch((error) =>
          logger.error("Scheduled follow-up sweep failed", {
            message: error instanceof Error ? error.message : "unknown",
          }),
        );
    }, FOLLOW_UP_INTERVAL_MS),
  );
}

/** Authoritative retention + insights: Postgres only (no Redis). */
function startMaintenanceDbSweeps() {
  intervals.push(
    setInterval(() => {
      runDailyAggregationSweep().catch((error) =>
        logger.error("Daily insights sweep failed", {
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }, MAINTENANCE_INTERVAL_MS),
  );

  intervals.push(
    setInterval(() => {
      pruneAgentArtifactsAllOrganisations().catch((error) =>
        logger.error("Agent retention sweep failed", {
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }, MAINTENANCE_INTERVAL_MS),
  );
}

async function startRedisWorkers() {
  assertRedisUrlAllowedForRuntime();
  const connection = getRedisConnection();
  const queueName = QUEUE_AGENT_RUNS();

  const agentRunsWorker = new Worker(queueName, processAgentRunJob, {
    connection,
    prefix: getBullMqPrefix(),
    concurrency: AGENT_RUN_CONCURRENCY,
    lockDuration: AGENT_RUN_LOCK_DURATION_MS,
    stalledInterval: AGENT_RUN_STALLED_INTERVAL_MS,
    maxStalledCount: 2,
  });

  workers.push(agentRunsWorker);

  agentRunsWorker.on("ready", () =>
    logger.info("BullMQ agent-runs worker ready", {
      queuePrefix: getQueuePrefix(),
      concurrency: AGENT_RUN_CONCURRENCY,
      lockDurationMs: AGENT_RUN_LOCK_DURATION_MS,
      stalledIntervalMs: AGENT_RUN_STALLED_INTERVAL_MS,
      cronFallbackEnabled: cronFallbackEnabled(),
    }),
  );

  agentRunsWorker.on("failed", (job, err) => {
    logger.error("Worker job failed", {
      queue: agentRunsWorker.name,
      jobId: job?.id,
      jobName: job?.name,
      message: err.message,
    });
    recordQueueOp("failed");
    void recordFailedJob({
      organisationId:
        typeof job?.data?.organisationId === "string" ? job.data.organisationId : null,
      queue: agentRunsWorker.name,
      jobName: job?.name || "unknown",
      payload: { jobId: job?.id, data: job?.data },
      error: err.message,
      attempts: job?.attemptsMade,
    });
  });

  agentRunsWorker.on("completed", (job) => {
    recordQueueOp("completed");
    logger.info("Worker job completed", {
      queue: agentRunsWorker.name,
      jobId: job.id,
      jobName: job.name,
    });
  });

  agentRunsWorker.on("active", () => {
    recordQueueOp("active");
  });

  markWorkerStarted({
    queues: [queueName],
    prefix: getQueuePrefix(),
  });

  startFollowUpDbSweep();
  startMaintenanceDbSweeps();
  runDailyAggregationSweep().catch(() => undefined);
  pruneAgentArtifactsAllOrganisations().catch(() => undefined);

  logger.info(
    "Worker started — 1 BullMQ worker (agent-runs); follow-ups + retention via Postgres intervals",
  );
}

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal} — draining workers (finish or requeue in-flight jobs)`);

  for (const timer of intervals) clearInterval(timer);
  markWorkerStopped();

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

  try {
    assertRedisUrlAllowedForRuntime();
  } catch (error) {
    logger.error("Worker refused to start — Redis URL not allowed for this runtime", {
      message: error instanceof Error ? error.message : "unknown",
    });
    process.exit(1);
  }

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
  startInProcessFollowUpLoop(FOLLOW_UP_INTERVAL_MS);
  startMaintenanceDbSweeps();
  logger.error(
    "⚠️  Worker running WITHOUT Redis — agent-runs queue inactive. " +
      "Start local Redis (docker compose up redis) and restart before testing long jobs.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
