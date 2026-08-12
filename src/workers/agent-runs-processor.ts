import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { recordFailedJob } from "@/services/failed-jobs";
import {
  noopPayloadSchema,
  sleepTestPayloadSchema,
  type AgentRunJobName,
} from "@/jobs/agent-runs";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Processes agent-runs queue jobs.
 * Prompt 2A: only infrastructure jobs (sleep-test, noop). No agent logic.
 */
export async function processAgentRunJob(job: Job): Promise<Record<string, unknown>> {
  const name = job.name as AgentRunJobName;
  const organisationId =
    typeof job.data?.organisationId === "string" ? job.data.organisationId : null;

  if (!organisationId) {
    throw new Error(`agent-runs job ${job.id} missing organisationId`);
  }

  logger.info("agent-runs job started", {
    jobId: job.id,
    name,
    organisationId,
    attemptsMade: job.attemptsMade,
  });

  try {
    if (name === "sleep-test") {
      const payload = sleepTestPayloadSchema.parse(job.data);
      const started = Date.now();
      const tickMs = Math.min(30_000, Math.max(5_000, Math.floor(payload.durationMs / 10)));
      let elapsed = 0;
      while (elapsed < payload.durationMs) {
        const wait = Math.min(tickMs, payload.durationMs - elapsed);
        await sleep(wait);
        elapsed = Date.now() - started;
        await job.updateProgress({
          organisationId,
          elapsedMs: elapsed,
          durationMs: payload.durationMs,
          pct: Math.min(100, Math.round((elapsed / payload.durationMs) * 100)),
        });
      }
      const result = {
        ok: true,
        organisationId,
        sleptMs: Date.now() - started,
        note: payload.note ?? null,
      };
      logger.info("agent-runs sleep-test completed", { jobId: job.id, ...result });
      return result;
    }

    if (name === "noop") {
      const payload = noopPayloadSchema.parse(job.data);
      return {
        ok: true,
        organisationId: payload.organisationId,
        message: payload.message ?? "noop",
      };
    }

    throw new Error(`Unknown agent-runs job name: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "agent-runs job failed";
    await recordFailedJob({
      organisationId,
      queue: "agent-runs",
      jobName: name,
      payload: job.data,
      error: message,
      attempts: job.attemptsMade,
    });
    throw error;
  }
}
