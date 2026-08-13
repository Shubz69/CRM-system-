import { z } from "zod";
import { logger } from "@/lib/logger";
import { getMaintenanceQueue, type JobsOptions } from "@/jobs/queues";
import { assertRedisAllowedFallback, pingRedis, redisRequired } from "@/jobs/redis";

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

async function enqueueMaintenanceJob(input: {
  name: MaintenanceJobName;
  organisationId?: string;
  payload?: Record<string, unknown>;
  opts?: JobsOptions;
}): Promise<{ jobId: string; enqueued: boolean }> {
  const ok = await pingRedis();
  if (!ok) {
    if (redisRequired()) {
      throw new Error("Cannot enqueue maintenance job: Redis is required and unavailable");
    }
    assertRedisAllowedFallback();
    return { jobId: "not-enqueued", enqueued: false };
  }

  try {
    const job = await getMaintenanceQueue().add(
      input.name,
      {
        ...(input.organisationId ? { organisationId: input.organisationId } : {}),
        ...(input.payload ?? {}),
      },
      input.opts,
    );
    logger.info("Enqueued maintenance job", {
      name: input.name,
      jobId: job.id,
      organisationId: input.organisationId ?? null,
    });
    return { jobId: job.id || "unknown", enqueued: true };
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

/** Daily retention sweep across orgs (or a single org when organisationId set). */
export async function enqueueAgentRetentionSweep(opts?: {
  organisationId?: string;
  schedule?: boolean;
}): Promise<{ jobId: string; enqueued: boolean }> {
  retentionPayloadSchema.parse({ organisationId: opts?.organisationId });
  return enqueueMaintenanceJob({
    name: "agent-retention-sweep",
    organisationId: opts?.organisationId,
    opts: opts?.schedule
      ? {
          // Hourly is enough; retention windows are measured in days.
          repeat: { every: 60 * 60 * 1000 },
          jobId: "agent-retention-sweep-hourly",
        }
      : undefined,
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
