/**
 * Rebuild eligible MissionTask → agent-runs queue after Redis loss.
 * Durable mission state stays in Postgres; this only ensures queue presence.
 */

import { MissionExternalOutcome, MissionStatus, MissionTaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enqueueAgentRunJob } from "@/jobs/agent-runs";
import { missionTaskJobId, pingRedis } from "@/jobs/redis";
import { getAgentRunsQueue } from "@/jobs/queues";
import { isRedisCircuitOpen } from "@/jobs/redis-circuit";

/**
 * Find READY tasks that should have queue work and ensure a BullMQ job exists.
 * Skips WAITING_APPROVAL / BLOCKED / terminal / CONFIRMED / RECONCILIATION_REQUIRED.
 */
export async function recoverMissionQueueJobs(input?: {
  organisationId?: string;
  limit?: number;
}): Promise<{ examined: number; enqueued: number; skipped: number }> {
  if (isRedisCircuitOpen()) {
    logger.warn("Mission queue recovery skipped — Redis provider circuit OPEN");
    return { examined: 0, enqueued: 0, skipped: 0 };
  }

  if (!(await pingRedis())) {
    logger.warn("Mission queue recovery skipped — Redis unavailable");
    return { examined: 0, enqueued: 0, skipped: 0 };
  }

  const limit = input?.limit ?? 50;
  const tasks = await prisma.missionTask.findMany({
    where: {
      ...(input?.organisationId ? { organisationId: input.organisationId } : {}),
      status: MissionTaskStatus.READY,
      externalOutcome: {
        in: [MissionExternalOutcome.NOT_STARTED, MissionExternalOutcome.FAILED],
      },
      mission: {
        status: {
          in: [
            MissionStatus.QUEUED,
            MissionStatus.PLANNING,
            MissionStatus.RUNNING,
            MissionStatus.RETRYING,
            MissionStatus.WAITING,
          ],
        },
      },
    },
    orderBy: [{ priority: "asc" }, { updatedAt: "asc" }],
    take: limit,
  });

  let enqueued = 0;
  let skipped = 0;
  const queue = getAgentRunsQueue();

  for (const task of tasks) {
    const jobId = missionTaskJobId(task.organisationId, task.id);
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") {
        // Allow re-add with same id only after remove — BullMQ keeps completed briefly.
        skipped += 1;
        continue;
      }
      skipped += 1;
      continue;
    }

    try {
      await enqueueAgentRunJob({
        name: "noop",
        organisationId: task.organisationId,
        payload: {
          organisationId: task.organisationId,
          message: `mission-task-recovery:${task.id}`,
          missionId: task.missionId,
          missionTaskId: task.id,
        },
        opts: { jobId },
      });
      enqueued += 1;
    } catch (error) {
      logger.warn("Mission queue recovery enqueue failed", {
        taskId: task.id,
        message: error instanceof Error ? error.message : "unknown",
      });
      skipped += 1;
    }
  }

  if (enqueued || tasks.length) {
    logger.info("Mission queue recovery sweep", {
      examined: tasks.length,
      enqueued,
      skipped,
    });
  }

  return { examined: tasks.length, enqueued, skipped };
}
