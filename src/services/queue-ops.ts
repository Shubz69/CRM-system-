/**
 * In-process queue / worker operations counters.
 * Admin views read these — do not poll Redis continuously for display.
 * Durable mission/business state remains in Postgres; these are process-local metrics.
 */

import { randomUUID } from "crypto";

export type QueueOpKind = "added" | "completed" | "failed" | "active" | "retried";

type WorkerMeta = {
  instanceId: string;
  startedAt: string;
  queues: string[];
  prefix: string;
  stoppedAt: string | null;
};

const counts: Record<QueueOpKind, number> = {
  added: 0,
  completed: 0,
  failed: 0,
  active: 0,
  retried: 0,
};

let workerMeta: WorkerMeta | null = null;

/** Soft singleton: second start in same process is refused. Cross-process needs deploy discipline. */
let startClaimed = false;

export function claimWorkerStart(): boolean {
  if (startClaimed) return false;
  startClaimed = true;
  return true;
}

export function releaseWorkerStart(): void {
  startClaimed = false;
}

export function markWorkerStarted(input: { queues: string[]; prefix: string }): void {
  if (!claimWorkerStart()) {
    throw new Error(
      "Duplicate worker start in the same process refused. Stop the existing worker before starting another.",
    );
  }
  workerMeta = {
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    queues: input.queues,
    prefix: input.prefix,
    stoppedAt: null,
  };
}

export function markWorkerStopped(): void {
  if (workerMeta) {
    workerMeta = { ...workerMeta, stoppedAt: new Date().toISOString() };
  }
  releaseWorkerStart();
}

export function recordQueueOp(kind: QueueOpKind, n = 1): void {
  counts[kind] += n;
}

export function getQueueOpsSnapshot(): {
  worker: WorkerMeta | null;
  uptimeMs: number | null;
  ops: Record<QueueOpKind, number>;
  note: string;
} {
  const uptimeMs =
    workerMeta && !workerMeta.stoppedAt
      ? Date.now() - new Date(workerMeta.startedAt).getTime()
      : null;
  return {
    worker: workerMeta,
    uptimeMs,
    ops: { ...counts },
    note:
      "Application-level counters for this process. Not Upstash billing. Refresh on demand — do not hammer Redis.",
  };
}

/** Test helper */
export function resetQueueOpsForTests(): void {
  for (const k of Object.keys(counts) as QueueOpKind[]) counts[k] = 0;
  workerMeta = null;
  startClaimed = false;
}
