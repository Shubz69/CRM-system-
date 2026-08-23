import { logger } from "@/lib/logger";
import type { JobsOptions } from "@/jobs/queues";
import { assertRedisAllowedFallback, redisRequired } from "@/jobs/redis";

/**
 * Follow-up sweeps are authoritative on the hosted worker via a Postgres
 * setInterval — they do NOT use BullMQ (P0 Redis cost fix).
 *
 * This enqueue is intentionally a no-op that never creates repeatable Redis jobs.
 * Prefer processDueFollowUps on the worker; Vercel cron only when CRON_FALLBACK_ENABLED=true.
 */
export async function enqueueFollowUpCheck(opts?: JobsOptions): Promise<{ enqueued: boolean }> {
  void opts;
  logger.info(
    "enqueueFollowUpCheck is a no-op — follow-ups run on the worker Postgres sweep (or CRON_FALLBACK_ENABLED)",
  );
  if (redisRequired()) {
    // Production: worker owns the sweep; do not create Redis traffic.
    return { enqueued: false };
  }
  assertRedisAllowedFallback();
  return { enqueued: false };
}
