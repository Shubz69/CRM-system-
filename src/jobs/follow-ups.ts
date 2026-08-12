import { logger } from "@/lib/logger";
import { getFollowUpQueue, type JobsOptions } from "@/jobs/queues";
import { assertRedisAllowedFallback, pingRedis, redisRequired } from "@/jobs/redis";

/**
 * Enqueue the periodic follow-up sweep. Next.js must only enqueue — never run
 * the sweep inside an HTTP handler for production workloads.
 */
export async function enqueueFollowUpCheck(opts?: JobsOptions): Promise<{ enqueued: boolean }> {
  const ok = await pingRedis();
  if (!ok) {
    if (redisRequired()) {
      throw new Error("Cannot enqueue follow-up job: Redis is required and unavailable");
    }
    assertRedisAllowedFallback();
    return { enqueued: false };
  }

  try {
    await getFollowUpQueue().add(
      "process-due-followups",
      {},
      {
        repeat: { every: 60_000 },
        ...opts,
      },
    );
    return { enqueued: true };
  } catch (error) {
    logger.warn("Could not enqueue follow-up job", {
      message: error instanceof Error ? error.message : "unknown",
    });
    if (redisRequired()) throw error;
    assertRedisAllowedFallback();
    return { enqueued: false };
  }
}
