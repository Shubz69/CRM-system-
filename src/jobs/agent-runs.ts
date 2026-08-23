import { z } from "zod";
import { logger } from "@/lib/logger";
import { getAgentRunsQueue, type JobsOptions } from "@/jobs/queues";
import { pingRedis, redisRequired, toSafeBullMqJobId} from "@/jobs/redis";
import { recordQueueOp } from "@/services/queue-ops";

/** Agent-runs queue also carries rare on-demand maintenance (single worker topology). */
export const agentRunJobNameSchema = z.enum([
  "sleep-test",
  "noop",
  "agent-framework-run",
  "agent-retention-sweep",
  "knowledge-embedding-backfill",
]);
export type AgentRunJobName = z.infer<typeof agentRunJobNameSchema>;

export const sleepTestPayloadSchema = z.object({
  organisationId: z.string().min(1),
  durationMs: z.number().int().min(1_000).max(15 * 60_000).default(5 * 60_000),
  note: z.string().max(500).optional(),
});

export type SleepTestPayload = z.infer<typeof sleepTestPayloadSchema>;

export const noopPayloadSchema = z.object({
  organisationId: z.string().min(1),
  message: z.string().max(200).optional(),
});

export const agentFrameworkRunPayloadSchema = z.object({
  organisationId: z.string().min(1),
  agentRunId: z.string().min(1),
});

export type AgentFrameworkRunPayload = z.infer<typeof agentFrameworkRunPayloadSchema>;

export type AgentRunJobPayload =
  | SleepTestPayload
  | z.infer<typeof noopPayloadSchema>
  | AgentFrameworkRunPayload;

/**
 * Enqueue a long-running agent-runs job. HTTP handlers must only call this —
 * execution happens on the worker host.
 */
export async function enqueueAgentRunJob(input: {
  name: AgentRunJobName;
  organisationId: string;
  payload: Record<string, unknown>;
  opts?: JobsOptions;
}): Promise<{ jobId: string }> {
  if (!(await pingRedis())) {
    throw new Error(
      redisRequired()
        ? "Cannot enqueue agent-runs job: Redis is required and unavailable"
        : "Cannot enqueue agent-runs job: Redis unavailable (agent-runs has no in-process fallback)",
    );
  }

  const queue = getAgentRunsQueue();
  const attempts = Math.min(
    typeof input.opts?.attempts === "number" ? input.opts.attempts : 2,
    3,
  );
  const job = await queue.add(
    input.name,
    {
      organisationId: input.organisationId,
      ...input.payload,
      enqueuedAt: new Date().toISOString(),
    },
    {
      ...(input.opts ?? {}),
      jobId:
        typeof input.opts?.jobId === "string" && input.opts.jobId.length > 0
          ? toSafeBullMqJobId(input.opts.jobId)
          : undefined,
      attempts,
    },
  );

  recordQueueOp("added");
  logger.info("Enqueued agent-runs job", {
    jobId: job.id,
    name: input.name,
    organisationId: input.organisationId,
  });

  if (!job.id) throw new Error("BullMQ returned a job without an id");
  return { jobId: job.id };
}

/** Convenience for the 5-minute verification job before Prompt 2B. */
export async function enqueueSleepTestJob(input: {
  organisationId: string;
  durationMs?: number;
  note?: string;
}): Promise<{ jobId: string; durationMs: number }> {
  const payload = sleepTestPayloadSchema.parse({
    organisationId: input.organisationId,
    durationMs: input.durationMs ?? 5 * 60_000,
    note: input.note,
  });
  const { jobId } = await enqueueAgentRunJob({
    name: "sleep-test",
    organisationId: payload.organisationId,
    payload,
  });
  return { jobId, durationMs: payload.durationMs };
}
