import { Queue, type DefaultJobOptions, type JobsOptions } from "bullmq";
import { getBullMqPrefix, getRedisConnection } from "@/jobs/redis";

/**
 * Stable logical queue names — must NEVER contain ":".
 * Environment isolation uses BullMQ's native `prefix` option (see getBullMqPrefix).
 */
export const QUEUE_FOLLOW_UPS_BASE = "follow-ups";
export const QUEUE_AGENT_RUNS_BASE = "agent-runs";
export const QUEUE_MAINTENANCE_BASE = "maintenance";

/** Logical queue names (no environment prefix in the name). */
export function QUEUE_FOLLOW_UPS(): string {
  return QUEUE_FOLLOW_UPS_BASE;
}
export function QUEUE_AGENT_RUNS(): string {
  return QUEUE_AGENT_RUNS_BASE;
}
export function QUEUE_MAINTENANCE(): string {
  return QUEUE_MAINTENANCE_BASE;
}

/** @deprecated use QUEUE_*() / *_BASE — same logical names */
export const QUEUE_FOLLOW_UPS_NAME = QUEUE_FOLLOW_UPS_BASE;
export const QUEUE_AGENT_RUNS_NAME = QUEUE_AGENT_RUNS_BASE;
export const QUEUE_MAINTENANCE_NAME = QUEUE_MAINTENANCE_BASE;

/** Shared BullMQ options — Queue and Worker must use the same prefix. */
export function getBullMqSharedOptions() {
  return {
    connection: getRedisConnection(),
    prefix: getBullMqPrefix(),
  };
}

/** Defaults for rare follow-up enqueue (prefer DB sweep — see workers/index). */
export const FOLLOW_UP_JOB_OPTIONS: DefaultJobOptions = {
  removeOnComplete: 20,
  removeOnFail: 50,
  attempts: 2,
  backoff: { type: "exponential", delay: 10_000 },
};

/**
 * Defaults for long-running agent work (2–10+ minutes).
 */
export const AGENT_RUN_JOB_OPTIONS: DefaultJobOptions = {
  removeOnComplete: 100,
  removeOnFail: 100,
  attempts: 2,
  backoff: { type: "exponential", delay: 15_000 },
};

export const MAINTENANCE_JOB_OPTIONS: DefaultJobOptions = {
  removeOnComplete: 20,
  removeOnFail: 50,
  attempts: 2,
  backoff: { type: "exponential", delay: 30_000 },
};

export const AGENT_RUN_LOCK_DURATION_MS = 15 * 60_000;
export const AGENT_RUN_CONCURRENCY = Number(process.env.AGENT_RUNS_CONCURRENCY || 2);

/**
 * Low-traffic stalled check for agent-runs (default BullMQ is aggressive).
 * Correctness preserved via lockDuration >> stalledInterval.
 */
export const AGENT_RUN_STALLED_INTERVAL_MS = Number(
  process.env.AGENT_RUN_STALLED_INTERVAL_MS || 120_000,
);

let followUpQueue: Queue | null = null;
let agentRunsQueue: Queue | null = null;
let maintenanceQueue: Queue | null = null;

export function getFollowUpQueue(): Queue {
  if (!followUpQueue) {
    followUpQueue = new Queue(QUEUE_FOLLOW_UPS(), {
      ...getBullMqSharedOptions(),
      defaultJobOptions: FOLLOW_UP_JOB_OPTIONS,
    });
  }
  return followUpQueue;
}

export function getAgentRunsQueue(): Queue {
  if (!agentRunsQueue) {
    agentRunsQueue = new Queue(QUEUE_AGENT_RUNS(), {
      ...getBullMqSharedOptions(),
      defaultJobOptions: AGENT_RUN_JOB_OPTIONS,
    });
  }
  return agentRunsQueue;
}

export function getMaintenanceQueue(): Queue {
  if (!maintenanceQueue) {
    maintenanceQueue = new Queue(QUEUE_MAINTENANCE(), {
      ...getBullMqSharedOptions(),
      defaultJobOptions: MAINTENANCE_JOB_OPTIONS,
    });
  }
  return maintenanceQueue;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([
    followUpQueue?.close().catch(() => undefined),
    agentRunsQueue?.close().catch(() => undefined),
    maintenanceQueue?.close().catch(() => undefined),
  ]);
  followUpQueue = null;
  agentRunsQueue = null;
  maintenanceQueue = null;
}

export type { JobsOptions };
