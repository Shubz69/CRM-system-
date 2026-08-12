import { Queue, type DefaultJobOptions, type JobsOptions } from "bullmq";
import { getRedisConnection } from "@/jobs/redis";

export const QUEUE_FOLLOW_UPS = "follow-ups";
export const QUEUE_AGENT_RUNS = "agent-runs";

/** Defaults for short periodic sweeps (follow-ups). */
export const FOLLOW_UP_JOB_OPTIONS: DefaultJobOptions = {
  removeOnComplete: 100,
  removeOnFail: 100,
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
};

/**
 * Defaults for long-running agent work (2–10+ minutes).
 * No aggressive lock/timeout — worker lockDuration is set separately.
 */
export const AGENT_RUN_JOB_OPTIONS: DefaultJobOptions = {
  removeOnComplete: 200,
  removeOnFail: 200,
  attempts: 2,
  backoff: { type: "exponential", delay: 15_000 },
};

/** BullMQ worker lock must outlive the longest expected job (5+ min sleep test). */
export const AGENT_RUN_LOCK_DURATION_MS = 15 * 60_000;
export const AGENT_RUN_CONCURRENCY = Number(process.env.AGENT_RUNS_CONCURRENCY || 2);

let followUpQueue: Queue | null = null;
let agentRunsQueue: Queue | null = null;

export function getFollowUpQueue(): Queue {
  if (!followUpQueue) {
    followUpQueue = new Queue(QUEUE_FOLLOW_UPS, {
      connection: getRedisConnection(),
      defaultJobOptions: FOLLOW_UP_JOB_OPTIONS,
    });
  }
  return followUpQueue;
}

export function getAgentRunsQueue(): Queue {
  if (!agentRunsQueue) {
    agentRunsQueue = new Queue(QUEUE_AGENT_RUNS, {
      connection: getRedisConnection(),
      defaultJobOptions: AGENT_RUN_JOB_OPTIONS,
    });
  }
  return agentRunsQueue;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([
    followUpQueue?.close().catch(() => undefined),
    agentRunsQueue?.close().catch(() => undefined),
  ]);
  followUpQueue = null;
  agentRunsQueue = null;
}

export type { JobsOptions };
