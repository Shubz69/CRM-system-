import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { enqueueSleepTestJob } from "@/jobs/agent-runs";
import { writeAuditLog } from "@/services/audit";
import { prisma } from "@/lib/db";
import { getAgentRunsQueue } from "@/jobs/queues";

const bodySchema = z.object({
  organisationId: z.string().min(1),
  /** Default 5 minutes — used to verify long jobs on the worker host. */
  durationMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
  note: z.string().max(500).optional(),
});

/**
 * Platform-admin only. Enqueues a sleep-test job on agent-runs.
 * Does NOT execute the sleep in the HTTP handler.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = bodySchema.parse(await req.json());

    const org = await prisma.organisation.findFirst({
      where: { id: body.organisationId, deletedAt: null },
      select: { id: true, slug: true },
    });
    if (!org) return jsonError("Organisation not found", 404);

    const { jobId, durationMs } = await enqueueSleepTestJob({
      organisationId: org.id,
      durationMs: body.durationMs,
      note: body.note,
    });

    await writeAuditLog({
      organisationId: org.id,
      userId: session.userId,
      action: "jobs.sleep_test_enqueued",
      entityType: "AgentRunJob",
      entityId: jobId,
      metadata: { durationMs, queue: "agent-runs" },
    });

    return Response.json({
      ok: true,
      jobId,
      queue: "agent-runs",
      durationMs,
      message:
        "Job enqueued. Watch the worker logs — it must complete on the worker host, not in this request.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAccess();
    const jobId = new URL(req.url).searchParams.get("jobId");
    if (!jobId) return jsonError("jobId required", 400);

    const job = await getAgentRunsQueue().getJob(jobId);
    if (!job) return jsonError("Job not found", 404);

    const state = await job.getState();
    return Response.json({
      jobId: job.id,
      name: job.name,
      state,
      progress: job.progress,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      returnvalue: job.returnvalue,
      data: {
        organisationId: job.data?.organisationId,
        durationMs: job.data?.durationMs,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
