import { z } from "zod";
import { logger } from "@/lib/logger";
import { enqueueAgentRunJob } from "@/jobs/agent-runs";
import { assertRedisAllowedFallback, pingRedis, redisRequired } from "@/jobs/redis";
import type { JobsOptions } from "@/jobs/queues";

export const maintenanceJobNameSchema = z.enum([
  "agent-retention-sweep",
  "knowledge-embedding-backfill",
]);

export type MaintenanceJobName = z.infer<typeof maintenanceJobNameSchema>;

const retentionPayloadSchema = z.object({
  organisationId: z.string().min(1).optional(),
});

const backfillPayloadSchema = z.object({
  organisationId: z.string().min(1),
  cursor: z.string().nullable().optional(),
  batchSize: z.number().int().positive().max(200).optional(),
});

export type RetentionJobPayload = z.infer<typeof retentionPayloadSchema>;
export type BackfillJobPayload = z.infer<typeof backfillPayloadSchema>;

/**
 * On-demand maintenance rides the agent-runs queue (single BullMQ worker).
 * Scheduled retention/insights do NOT use Redis — worker Postgres intervals own those.
 * Never create hourly/minute repeatable Redis jobs.
 */
async function enqueueMaintenanceJob(input: {
  name: MaintenanceJobName;
  organisationId?: string;
  payload?: Record<string, unknown>;
  opts?: JobsOptions;
}): Promise<{ jobId: string; enqueued: boolean }> {
  const orgId = input.organisationId ?? "system";
  const ok = await pingRedis();
  if (!ok) {
    if (redisRequired()) {
      throw new Error("Cannot enqueue maintenance job: Redis is required and unavailable");
    }
    assertRedisAllowedFallback();
    return { jobId: "not-enqueued", enqueued: false };
  }

  try {
    const { jobId } = await enqueueAgentRunJob({
      name: input.name,
      organisationId: orgId,
      payload: {
        ...(input.organisationId ? { organisationId: input.organisationId } : {}),
        ...(input.payload ?? {}),
      },
      opts: {
        ...input.opts,
        // Cap retries — runaway protection
        attempts: Math.min(input.opts?.attempts ?? 2, 3),
      },
    });
    logger.info("Enqueued on-demand maintenance via agent-runs", {
      name: input.name,
      jobId,
      organisationId: input.organisationId ?? null,
    });
    return { jobId, enqueued: true };
  } catch (error) {
    logger.warn("Could not enqueue maintenance job", {
      name: input.name,
      message: error instanceof Error ? error.message : "unknown",
    });
    if (redisRequired()) throw error;
    assertRedisAllowedFallback();
    return { jobId: "not-enqueued", enqueued: false };
  }
}

/**
 * On-demand retention for one org (or all). Prefer the worker hourly Postgres sweep
 * for routine work — do not schedule Redis repeatables.
 */
export async function enqueueAgentRetentionSweep(opts?: {
  organisationId?: string;
  /** @deprecated Ignored — repeatable Redis schedules removed (P0). */
  schedule?: boolean;
}): Promise<{ jobId: string; enqueued: boolean }> {
  retentionPayloadSchema.parse({ organisationId: opts?.organisationId });
  if (opts?.schedule) {
    logger.info(
      "enqueueAgentRetentionSweep({ schedule: true }) ignored — retention uses worker Postgres interval",
    );
    return { jobId: "not-scheduled", enqueued: false };
  }
  return enqueueMaintenanceJob({
    name: "agent-retention-sweep",
    organisationId: opts?.organisationId,
  });
}

/** Embed chunks missing vectors — idempotent and resumable via cursor. */
export async function enqueueKnowledgeEmbeddingBackfill(input: {
  organisationId: string;
  cursor?: string | null;
  batchSize?: number;
}): Promise<{ jobId: string; enqueued: boolean }> {
  const payload = backfillPayloadSchema.parse(input);
  return enqueueMaintenanceJob({
    name: "knowledge-embedding-backfill",
    organisationId: payload.organisationId,
    payload: {
      cursor: payload.cursor ?? null,
      batchSize: payload.batchSize,
    },
  });
}
