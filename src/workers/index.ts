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
import {
  clearRedisCircuit,
  getRedisCircuitSnapshot,
  isFatalRedisProviderError,
  isRedisCircuitOpen,
  isRedisRecoveryProbeDue,
  noteRedisError,
  noteRedisRecoveryProbeFailed,
  setRedisCircuitHooks,
} from "@/jobs/redis-circuit";
import { errorThrottleKey, logThrottled } from "@/jobs/redis-backoff";
import { pruneRunLogs, RUN_LOG_RETENTION_DEFAULT_DAYS } from "@/services/run-log-retention";
import { sweepEligibleOrganisationWhere } from "@/services/sweep-eligibility";
import { processDueFollowUps, startInProcessFollowUpLoop } from "@/workers/followups";
import { processAgentRunJob } from "@/workers/agent-runs-processor";
import { aggregateDailyInsights } from "@/services/insights-aggregation";
import { pruneAgentArtifactsAllOrganisations } from "@/services/agent-retention";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordFailedJob } from "@/services/failed-jobs";
import { assertProductionSecretsConfigured } from "@/lib/env";
import {
  markWorkerDegraded,
  markWorkerStarted,
  markWorkerStopped,
  recordQueueOp,
} from "@/services/queue-ops";
import { writeWorkerHeartbeat } from "@/services/worker-heartbeat";
import {
  getAiProviderConfigPreflight,
  probeAiProviderAuth,
} from "@/services/ai-provider-preflight";
import {
  dispatchDomainEventBatch,
  recoverStaleDomainEventClaims,
  recoverMissionQueueJobs,
} from "@/services/domain-events";
import {
  expireDueOpportunities,
  runOpportunityDetectorSweep,
} from "@/services/opportunities";
import { refreshKpiFromCalculator } from "@/services/goals";
import { processDuePublishingJobs } from "@/workers/publishing-sweep";
import { sweepContinuousIntelligence } from "@/services/continuous-intelligence";
import {
  ensureProcessDefinitions,
  reconcileProcessWindow,
} from "@/services/process-twin";

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
/** Outbox Postgres sweep — not a permanent BullMQ worker (Redis cost rule). */
const OUTBOX_INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS || 15_000);
/** Recovery-only path (Redis loss) — every 5 min; each pass costs Redis commands per task. */
const MISSION_QUEUE_RECOVERY_INTERVAL_MS = Number(
  process.env.MISSION_QUEUE_RECOVERY_INTERVAL_MS || 5 * 60_000,
);
/**
 * Opportunity detectors — hourly Postgres sweep (no new BullMQ worker). Detector
 * thresholds are measured in days (7/14/30), so 15-minute sweeps only added writes.
 */
const OPPORTUNITY_DETECTOR_INTERVAL_MS = Number(
  process.env.OPPORTUNITY_DETECTOR_INTERVAL_MS || 60 * 60_000,
);
const KPI_REFRESH_INTERVAL_MS = Number(process.env.KPI_REFRESH_INTERVAL_MS || 60 * 60_000);
/** Phase 15 — publishing dispatch via Postgres sweep (no new BullMQ worker). */
const PUBLISHING_SWEEP_INTERVAL_MS = Number(process.env.PUBLISHING_SWEEP_INTERVAL_MS || 30_000);
/**
 * Phase 16 — continuous intelligence metric sweep (no new BullMQ worker). It only
 * re-reads PostPerformance already in Postgres, so every 2h is plenty.
 */
const CONTINUOUS_INTEL_SWEEP_INTERVAL_MS = Number(
  process.env.CONTINUOUS_INTEL_SWEEP_INTERVAL_MS || 2 * 60 * 60_000,
);
/**
 * Run-log retention (OpportunityDetectorRun / ContinuousCollectionRun older than
 * RUN_LOG_RETENTION_DAYS, default 30). OFF unless RUN_LOG_RETENTION_ENABLED=true —
 * enabling it deletes data, so it needs the owner's go-ahead.
 */
const RUN_LOG_RETENTION_ENABLED = process.env.RUN_LOG_RETENTION_ENABLED === "true";
const RUN_LOG_RETENTION_DAYS = Number(
  process.env.RUN_LOG_RETENTION_DAYS || RUN_LOG_RETENTION_DEFAULT_DAYS,
);
/** BullMQ idle block time (seconds). New jobs still wake the worker immediately via the marker key. */
const AGENT_RUN_DRAIN_DELAY_SEC = Number(process.env.AGENT_RUN_DRAIN_DELAY_SEC || 30);
/** Unclassified worker errors above this rate pause the worker with exponential back-off. */
const WORKER_ERROR_STORM_THRESHOLD = 20;
const WORKER_ERROR_STORM_WINDOW_MS = 10_000;
const WORKER_ERROR_PAUSE_BASE_MS = 30_000;
const WORKER_ERROR_PAUSE_MAX_MS = 10 * 60_000;
/** Phase 20F — process twin reconciliation (low frequency; no new BullMQ worker). */
const PROCESS_TWIN_RECONCILE_INTERVAL_MS = Number(
  process.env.PROCESS_TWIN_RECONCILE_INTERVAL_MS || 6 * 60 * 60_000,
);
/**
 * How often to check whether a recovery probe is due. The probe itself (one PING)
 * follows the circuit's exponential schedule: 5 min, 10, 20, … capped at 60 min.
 */
const REDIS_CIRCUIT_PROBE_CHECK_MS = 30_000;

/** Skip a tick while the previous run of the same sweep is still in flight. */
const sweepsInFlight = new Set<string>();
async function runExclusive(name: string, fn: () => Promise<void>): Promise<void> {
  if (sweepsInFlight.has(name)) {
    logThrottled("warn", `sweep-overlap:${name}`, "Sweep still running — skipping tick", {
      sweep: name,
    });
    return;
  }
  sweepsInFlight.add(name);
  try {
    await fn();
  } finally {
    sweepsInFlight.delete(name);
  }
}

/** Re-enqueue eligible READY mission tasks after Redis loss — skipped while circuit OPEN. */
function startMissionQueueRecoverySweep() {
  intervals.push(
    setInterval(() => {
      if (isRedisCircuitOpen()) return;
      void runExclusive("mission-queue-recovery", async () => {
        await recoverMissionQueueJobs().then(
          () => undefined,
          (error) => {
            noteRedisError(error);
            logThrottled(
              "error",
              errorThrottleKey("mission-recovery", error),
              "Mission queue recovery failed",
              { message: error instanceof Error ? error.message : "unknown" },
              15 * 60_000,
            );
          },
        );
      });
    }, MISSION_QUEUE_RECOVERY_INTERVAL_MS),
  );
}

function startRedisCircuitRecoveryProbe() {
  let probing = false;
  intervals.push(
    setInterval(() => {
      if (probing || !isRedisRecoveryProbeDue()) return;
      probing = true;
      void (async () => {
        const ok = await pingRedis(2000, { bypassCircuit: true }).catch(() => false);
        if (ok) {
          clearRedisCircuit("recovery_probe_ok");
        } else {
          noteRedisRecoveryProbeFailed();
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          probing = false;
        });
    }, REDIS_CIRCUIT_PROBE_CHECK_MS),
  );
}

async function runDailyAggregationSweep() {
  const orgs = await prisma.organisation.findMany({
    where: sweepEligibleOrganisationWhere(),
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

  if (RUN_LOG_RETENTION_ENABLED) {
    intervals.push(
      setInterval(() => {
        void runExclusive("run-log-retention", async () => {
          // ≤20 batches × 5k rows per table per hour — clears a large backlog gradually.
          await pruneRunLogs({ retentionDays: RUN_LOG_RETENTION_DAYS }).then(
            () => undefined,
            (error) =>
              logger.error("Run-log retention sweep failed", {
                message: error instanceof Error ? error.message : "unknown",
              }),
          );
        });
      }, MAINTENANCE_INTERVAL_MS),
    );
  }
}

/** Phase 12B — Postgres outbox + stale claim recovery (no extra BullMQ worker). */
function startOutboxDbSweep() {
  intervals.push(
    setInterval(() => {
      void (async () => {
        try {
          await recoverStaleDomainEventClaims();
          await dispatchDomainEventBatch();
        } catch (error) {
          logger.error("Outbox sweep failed", {
            message: error instanceof Error ? error.message : "unknown",
          });
        }
      })();
    }, OUTBOX_INTERVAL_MS),
  );
}

/** Opportunity detectors — conservative Postgres sweep (no new BullMQ worker). */
function startOpportunityDetectorSweep() {
  intervals.push(
    setInterval(() => {
      void runExclusive("opportunity-detectors", async () => {
        try {
          await expireDueOpportunities();
          await runOpportunityDetectorSweep(50);
        } catch (error) {
          logger.error("Opportunity detector sweep failed", {
            message: error instanceof Error ? error.message : "unknown",
          });
        }
      });
    }, OPPORTUNITY_DETECTOR_INTERVAL_MS),
  );
}

/** Phase 13 — refresh KPI snapshots from deterministic calculators (hourly). */
function startKpiRefreshSweep() {
  intervals.push(
    setInterval(() => {
      void (async () => {
        try {
          const kpis = await prisma.kpiDefinition.findMany({
            take: 100,
            orderBy: { updatedAt: "desc" },
            select: { id: true, organisationId: true },
          });
          for (const kpi of kpis) {
            await refreshKpiFromCalculator({
              organisationId: kpi.organisationId,
              kpiDefinitionId: kpi.id,
            }).catch(() => undefined);
          }
        } catch (error) {
          logger.error("KPI refresh sweep failed", {
            message: error instanceof Error ? error.message : "unknown",
          });
        }
      })();
    }, KPI_REFRESH_INTERVAL_MS),
  );
}

/** Phase 15 — due PublishingJobs → real adapter.publish (Postgres only). */
function startPublishingSweep() {
  intervals.push(
    setInterval(() => {
      processDuePublishingJobs(20).catch((error) =>
        logger.error("Publishing sweep failed", {
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }, PUBLISHING_SWEEP_INTERVAL_MS),
  );
}

/** Phase 16 — ContinuousCollectionRun + append-only snapshots from existing engagement. */
function startContinuousIntelSweep() {
  intervals.push(
    setInterval(() => {
      void runExclusive("continuous-intel", () =>
        sweepContinuousIntelligence(50)
          .then((result) => {
            if (result.runsCreated > 0) {
              logger.info("Continuous intelligence sweep complete", result);
            }
          })
          .catch((error) =>
            logger.error("Continuous intelligence sweep failed", {
              message: error instanceof Error ? error.message : "unknown",
            }),
          ),
      );
    }, CONTINUOUS_INTEL_SWEEP_INTERVAL_MS),
  );
}

/** Phase 20F — low-frequency process twin rate repair (Postgres only). */
function startProcessTwinReconcileSweep() {
  intervals.push(
    setInterval(() => {
      void (async () => {
        try {
          await ensureProcessDefinitions();
          const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
          const orgs = await prisma.organisation.findMany({
            where: sweepEligibleOrganisationWhere(),
            select: { id: true },
            take: 100,
            orderBy: { lastActivityAt: "desc" },
          });
          for (const org of orgs) {
            for (const processKey of [
              "lead_funnel",
              "deal_funnel",
              "content_lifecycle",
              "opportunity_mission",
              "publishing",
              "approvals",
            ]) {
              await reconcileProcessWindow(org.id, processKey, since);
            }
          }
        } catch (error) {
          logger.error("Process twin reconcile sweep failed", {
            message: error instanceof Error ? error.message : "unknown",
          });
        }
      })();
    }, PROCESS_TWIN_RECONCILE_INTERVAL_MS),
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
    // Idle BZPOPMIN for 30s instead of 5s — ~6× fewer idle Redis commands.
    drainDelay: AGENT_RUN_DRAIN_DELAY_SEC,
  });

  workers.push(agentRunsWorker);

  /**
   * Storm guard for error replies the circuit does not classify: BullMQ's fetch loop
   * swallows non-connection errors (onlyEmitError) and retries immediately, so a
   * repeating error reply would loop several times a second. Pause with exponential
   * back-off instead (30s, 1m, 2m … capped at 10m); reset after a quiet period.
   */
  const recentWorkerErrors: number[] = [];
  let stormPauseMs = 0;
  let stormResumeTimer: NodeJS.Timeout | null = null;
  let lastStormAt = 0;
  function noteWorkerErrorForStormGuard() {
    const now = Date.now();
    recentWorkerErrors.push(now);
    while (recentWorkerErrors.length && now - recentWorkerErrors[0]! > WORKER_ERROR_STORM_WINDOW_MS) {
      recentWorkerErrors.shift();
    }
    if (recentWorkerErrors.length < WORKER_ERROR_STORM_THRESHOLD) return;
    if (stormResumeTimer || agentRunsWorker.isPaused() || shuttingDown) return;
    recentWorkerErrors.length = 0;
    stormPauseMs =
      now - lastStormAt > WORKER_ERROR_PAUSE_MAX_MS * 2
        ? WORKER_ERROR_PAUSE_BASE_MS
        : Math.min(Math.max(stormPauseMs * 2, WORKER_ERROR_PAUSE_BASE_MS), WORKER_ERROR_PAUSE_MAX_MS);
    lastStormAt = now;
    logger.error("BullMQ agent-runs worker error storm — pausing fetch loop", {
      pauseMs: stormPauseMs,
      threshold: WORKER_ERROR_STORM_THRESHOLD,
      windowMs: WORKER_ERROR_STORM_WINDOW_MS,
    });
    void agentRunsWorker.pause(true).catch(() => undefined);
    stormResumeTimer = setTimeout(() => {
      stormResumeTimer = null;
      // The fatal-provider circuit owns resume while it is OPEN.
      if (shuttingDown || isRedisCircuitOpen()) return;
      if (agentRunsWorker.isPaused()) {
        agentRunsWorker.resume();
        logger.info("BullMQ agent-runs worker resumed after error-storm pause", {
          pausedMs: stormPauseMs,
        });
      }
    }, stormPauseMs);
  }

  /**
   * BullMQ 5.x: Worker.pause() sets paused=true and stops the main fetch loop
   * (`while (!this.paused)`). Quota command errors are non-connection errors with
   * onlyEmitError — without pause they re-enter the loop and storm EVALSHA.
   * doNotWaitActive=true avoids waiting on in-flight jobs during emergency stop.
   * Do NOT process.exit — Railway restartPolicyType=ON_FAILURE would crash-loop.
   */
  setRedisCircuitHooks({
    onOpen: async () => {
      markWorkerDegraded(true, "REDIS_PROVIDER_QUOTA");
      if (!agentRunsWorker.isPaused()) {
        await agentRunsWorker.pause(true);
        logger.error("BullMQ agent-runs worker paused — Redis provider circuit OPEN", {
          circuit: getRedisCircuitSnapshot(),
        });
      }
    },
    onRecover: async () => {
      markWorkerDegraded(false);
      if (agentRunsWorker.isPaused()) {
        agentRunsWorker.resume();
        logger.info("BullMQ agent-runs worker resumed — Redis provider circuit CLOSED");
      }
    },
  });

  agentRunsWorker.on("error", (err) => {
    if (noteRedisError(err)) return;
    if (isFatalRedisProviderError(err) && isRedisCircuitOpen()) return;
    noteWorkerErrorForStormGuard();
    // Same error repeating in a loop — log once per minute with a suppressed count.
    logThrottled("error", errorThrottleKey("bullmq-worker", err), "BullMQ agent-runs worker error", {
      message: err.message,
    });
  });

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
    noteRedisError(err);
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

  // Started while the provider was already rate-limiting (circuit opened by the boot
  // ping): stay paused until the recovery probe succeeds instead of looping.
  // (After the "error" listener is attached — an unhandled "error" event would crash.)
  if (isRedisCircuitOpen()) {
    await agentRunsWorker.pause(true).catch(() => undefined);
    logger.error("BullMQ agent-runs worker started paused — Redis provider circuit OPEN", {
      circuit: getRedisCircuitSnapshot(),
    });
  }

  markWorkerStarted({
    queues: [queueName],
    prefix: getQueuePrefix(),
  });
  if (isRedisCircuitOpen()) markWorkerDegraded(true, "REDIS_PROVIDER_QUOTA");
  const heartbeatInstanceId = `${process.pid}-${Date.now()}`;
  const pulseHeartbeat = () =>
    writeWorkerHeartbeat({
      instanceId: heartbeatInstanceId,
      queues: [queueName],
    });
  await pulseHeartbeat();
  intervals.push(setInterval(() => void pulseHeartbeat(), 15_000));

  // AI provider preflight — config sync, cheap auth probe once (internal only).
  {
    const preflight = getAiProviderConfigPreflight();
    if (preflight.degraded) {
      markWorkerDegraded(true, `ai_provider:${preflight.status}`);
      logger.warn("Worker AI provider preflight degraded", {
        provider: preflight.provider,
        status: preflight.status,
        detail: preflight.detail,
      });
    } else {
      logger.info("Worker AI provider config preflight OK", {
        provider: preflight.provider,
        status: preflight.status,
      });
    }
    void probeAiProviderAuth()
      .then((result) => {
        if (result.degraded || result.authValid === false) {
          markWorkerDegraded(true, `ai_provider:${result.status}`);
          logger.warn("Worker AI provider auth preflight failed", {
            provider: result.provider,
            status: result.status,
          });
        }
      })
      .catch(() => undefined);
  }

  startFollowUpDbSweep();
  startMaintenanceDbSweeps();
  startOutboxDbSweep();
  startMissionQueueRecoverySweep();
  startRedisCircuitRecoveryProbe();
  startOpportunityDetectorSweep();
  startKpiRefreshSweep();
  startPublishingSweep();
  startContinuousIntelSweep();
  startProcessTwinReconcileSweep();
  runDailyAggregationSweep().catch(() => undefined);
  pruneAgentArtifactsAllOrganisations().catch(() => undefined);
  void dispatchDomainEventBatch().catch(() => undefined);

  logger.info(
    "Worker started — 1 BullMQ worker (agent-runs); follow-ups + retention + outbox + mission-queue + opportunity detectors + KPI refresh + publishing + continuous-intel + process-twin reconcile via Postgres intervals; Redis quota circuit armed",
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
  // Rate-limited / over quota is not "down": exiting would make Railway restart-loop
  // (ON_FAILURE) and reconnect repeatedly. Start paused behind the circuit instead.
  if (redisOk || isRedisCircuitOpen()) {
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
