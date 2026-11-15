import type { FailedJob } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getPlatformOrganisationId } from "@/lib/platform-org";

export async function recordFailedJob(input: {
  organisationId?: string | null;
  queue: string;
  jobName: string;
  payload?: unknown;
  error: string;
  attempts?: number;
}) {
  try {
    const organisationId = input.organisationId || (await getPlatformOrganisationId());
    return await prisma.failedJob.create({
      data: {
        organisationId,
        queue: input.queue,
        jobName: input.jobName,
        payload: (input.payload as object) ?? {},
        error: input.error.slice(0, 4000),
        attempts: input.attempts ?? 1,
      },
    });
  } catch (error) {
    logger.error("Failed to persist FailedJob", {
      message: error instanceof Error ? error.message : "unknown",
      queue: input.queue,
    });
    return null;
  }
}

export type FailedJobRetryOutcome =
  | { ok: true; detail: string; requeuedJobId?: string }
  | { ok: false; status: number; reason: string };

type RetryableFailedJob = Pick<FailedJob, "id" | "organisationId" | "queue" | "jobName" | "payload">;

/** Bookkeeping keys earlier retries / the queue add to a payload — never part of the job input. */
const RETRY_BOOKKEEPING_KEYS = new Set(["retryRequestedAt", "retryKey", "retryBy", "enqueuedAt"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unsupported(job: RetryableFailedJob): FailedJobRetryOutcome {
  return {
    ok: false,
    status: 422,
    reason: `Retry isn't supported for ${job.queue} / ${job.jobName} jobs. Fix the cause, then dismiss the job with Cancel.`,
  };
}

/**
 * A failed follow-up send is retried by putting the follow-up back on the schedule; the
 * follow-up sweep (worker, or cron fallback) sends it on its next run with all the normal
 * checks (opt-out, messaging window, approval mode).
 */
async function retryFollowUpSend(job: RetryableFailedJob): Promise<FailedJobRetryOutcome> {
  const followUpId = asRecord(job.payload)?.followUpId;
  if (typeof followUpId !== "string" || !followUpId) {
    return { ok: false, status: 422, reason: "This job has no follow-up id, so it can't be retried." };
  }
  const followUp = await prisma.followUp.findFirst({
    where: { id: followUpId, organisationId: job.organisationId },
    select: { id: true, status: true, cancelReason: true },
  });
  if (!followUp) {
    return { ok: false, status: 409, reason: "The follow-up no longer exists, so there is nothing to retry." };
  }
  if (followUp.status === "SCHEDULED") {
    return { ok: true, detail: "The follow-up is already scheduled to send." };
  }
  if (followUp.status === "SENT") {
    return { ok: false, status: 409, reason: "This follow-up has since been sent. Nothing to retry." };
  }
  if (followUp.status === "CANCELLED") {
    return {
      ok: false,
      status: 409,
      reason: `This follow-up was cancelled${followUp.cancelReason ? ` (${followUp.cancelReason})` : ""}. Nothing to retry.`,
    };
  }

  // The send reuses the idempotency key `followup:<id>`. A dispatch that the provider
  // rejected, or that may have reached the customer, is never re-sent from here.
  const dispatch = await prisma.outboundDispatch.findUnique({
    where: {
      organisationId_idempotencyKey: {
        organisationId: job.organisationId,
        idempotencyKey: `followup:${followUp.id}`,
      },
    },
    select: { externalOutcome: true },
  });
  if (dispatch?.externalOutcome === "CONFIRMED") {
    return { ok: false, status: 409, reason: "The follow-up message was already delivered. Nothing to retry." };
  }
  if (
    dispatch?.externalOutcome === "FAILED" ||
    dispatch?.externalOutcome === "RECONCILIATION_REQUIRED" ||
    dispatch?.externalOutcome === "DISPATCHING"
  ) {
    return {
      ok: false,
      status: 409,
      reason:
        "The messaging provider rejected this follow-up, or may already have delivered it, so it can't be re-sent automatically. Send a new message from the inbox if it's still needed.",
    };
  }

  const rescheduled = await prisma.followUp.updateMany({
    where: { id: followUp.id, status: "FAILED" },
    data: { status: "SCHEDULED", scheduledFor: new Date(), cancelReason: null },
  });
  if (rescheduled.count === 0) {
    return { ok: false, status: 409, reason: "The follow-up changed while retrying. Refresh and try again." };
  }
  return {
    ok: true,
    detail: "Follow-up re-queued — it will send on the next follow-up run (about a minute).",
  };
}

/** Re-enqueue an agent-runs job with its original input. */
async function retryAgentRunsJob(job: RetryableFailedJob): Promise<FailedJobRetryOutcome> {
  const { agentRunJobNameSchema, enqueueAgentRunJob } = await import("@/jobs/agent-runs");
  const name = agentRunJobNameSchema.safeParse(job.jobName);
  if (!name.success) return unsupported(job);

  // Two recorders: the processor stores job.data, the worker "failed" hook stores { jobId, data }.
  const payload = asRecord(job.payload) ?? {};
  const source = asRecord(payload.data) ?? payload;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!RETRY_BOOKKEEPING_KEYS.has(key)) data[key] = value;
  }
  const organisationId =
    typeof data.organisationId === "string" && data.organisationId
      ? data.organisationId
      : name.data === "agent-retention-sweep"
        ? "system"
        : null;
  if (!organisationId) {
    return { ok: false, status: 422, reason: "This job's stored input has no workspace, so it can't be retried." };
  }

  if (name.data === "agent-framework-run") {
    const runId = typeof data.agentRunId === "string" ? data.agentRunId : null;
    if (!runId) {
      return { ok: false, status: 422, reason: "This job has no agent run id, so it can't be retried." };
    }
    const run = await prisma.agentRun.findFirst({
      where: { id: runId, organisationId },
      select: { status: true, _count: { select: { steps: true } } },
    });
    if (!run) {
      return { ok: false, status: 409, reason: "The agent run no longer exists, so there is nothing to retry." };
    }
    // The executor only starts runs that haven't begun — anything else would be a no-op.
    if ((run.status !== "PENDING" && run.status !== "PLANNING") || run._count.steps > 0) {
      return {
        ok: false,
        status: 409,
        reason: `This agent run already ended (${run.status}), so the worker won't run it again. Ask the user to send the request again.`,
      };
    }
  }

  try {
    const { jobId } = await enqueueAgentRunJob({
      name: name.data,
      organisationId,
      payload: data,
      // Stable id: a double-clicked retry can't queue the work twice.
      opts: { jobId: `failed-job-retry-${job.id}` },
    });
    return { ok: true, detail: "Job re-queued on the agent-runs worker.", requeuedJobId: jobId };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      reason: `Couldn't re-queue the job: ${error instanceof Error ? error.message : "queue unavailable"}. It is still open.`,
    };
  }
}

/**
 * Actually re-run (or re-queue) a failed job. Only returns ok once the work is back in a
 * queue / schedule; callers must leave the FailedJob open otherwise.
 */
export async function retryFailedJob(job: RetryableFailedJob): Promise<FailedJobRetryOutcome> {
  if (job.queue === "follow-ups" && job.jobName === "send-followup") {
    return retryFollowUpSend(job);
  }
  if (job.queue === "agent-runs") {
    return retryAgentRunsJob(job);
  }
  return unsupported(job);
}
