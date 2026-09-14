/**
 * Cross-process hosted-worker liveness (Railway worker ↔ Vercel web).
 * Redis SETEX from the worker; on-demand GET from AI Ops / Ask dispatch.
 * One write every ~15s — not a polling loop from the web app.
 */
import { getBullMqPrefix, getRedisConnection } from "@/jobs/redis";
import { logger } from "@/lib/logger";

export const WORKER_HEARTBEAT_TTL_SECONDS = 45;
export const WORKER_HEARTBEAT_STALE_MS = 30_000;

export type WorkerHeartbeat = {
  ts: number;
  instanceId: string;
  queues: string[];
  prefix: string;
};

export function workerHeartbeatRedisKey(prefix = getBullMqPrefix()): string {
  return `${prefix}:agent-desk:worker-heartbeat`;
}

export function isWorkerHeartbeatFresh(atMs: number | null | undefined, now = Date.now()): boolean {
  if (atMs == null || !Number.isFinite(atMs)) return false;
  return now - atMs < WORKER_HEARTBEAT_STALE_MS;
}

export function parseWorkerHeartbeat(raw: string | null): WorkerHeartbeat | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkerHeartbeat>;
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) return null;
    if (typeof parsed.instanceId !== "string" || !parsed.instanceId.trim()) return null;
    if (typeof parsed.prefix !== "string") return null;
    return {
      ts: parsed.ts,
      instanceId: parsed.instanceId,
      queues: Array.isArray(parsed.queues)
        ? parsed.queues.filter((q): q is string => typeof q === "string")
        : [],
      prefix: parsed.prefix,
    };
  } catch {
    return null;
  }
}

export async function writeWorkerHeartbeat(input: {
  instanceId: string;
  queues: string[];
}): Promise<void> {
  try {
    const prefix = getBullMqPrefix();
    const conn = getRedisConnection();
    const payload: WorkerHeartbeat = {
      ts: Date.now(),
      instanceId: input.instanceId,
      queues: input.queues,
      prefix,
    };
    await conn.set(
      workerHeartbeatRedisKey(prefix),
      JSON.stringify(payload),
      "EX",
      WORKER_HEARTBEAT_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn("Worker heartbeat write skipped", {
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function readWorkerHeartbeat(): Promise<WorkerHeartbeat | null> {
  try {
    const conn = getRedisConnection();
    const raw = await conn.get(workerHeartbeatRedisKey());
    return parseWorkerHeartbeat(raw);
  } catch (error) {
    logger.warn("Worker heartbeat read skipped", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

export async function isHostedWorkerLive(now = Date.now()): Promise<boolean> {
  const beat = await readWorkerHeartbeat();
  return isWorkerHeartbeatFresh(beat?.ts ?? null, now);
}

/**
 * Decide whether Ask should enqueue BullMQ vs run in-process.
 * QUICK research/CRM never enqueue. DEEP/other durable work needs a live worker
 * on the same Redis prefix — otherwise queue wait burns the wall-clock with 0 steps.
 */
export function shouldEnqueueDurableAgentRun(input: {
  inProcessSync: boolean;
  answerMode: string | null | undefined;
  looksLikeResearch: boolean;
  hostedWorkerLive: boolean;
}): boolean {
  if (input.inProcessSync) return false;
  if (!input.hostedWorkerLive) return false;
  if (input.answerMode === "QUICK" && input.looksLikeResearch) return false;
  return (
    input.answerMode === "DEEP" ||
    (input.looksLikeResearch && input.answerMode !== "QUICK")
  );
}

export function hostedWorkerOpsMessage(input: {
  redisOk: boolean;
  hostedWorkerLive: boolean;
}): string {
  if (!input.redisOk) {
    return "Redis down — DEEP Ask cannot queue. QUICK Ask still runs in the web process. Start Redis + `npm run worker` on Railway/Render.";
  }
  if (input.hostedWorkerLive) {
    return "Hosted worker heartbeat is fresh. QUICK Ask runs in-process; DEEP Ask uses Railway/Render `npm run worker`.";
  }
  return "Redis reachable but hosted worker is not running (heartbeat stale). QUICK Ask still runs in the web process. DEEP Ask will stall until you start `npm run worker` on Railway/Render (same REDIS_URL + QUEUE_PREFIX as Vercel).";
}
