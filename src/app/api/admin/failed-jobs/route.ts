import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { hashForIdempotency } from "@/lib/crypto";

const schema = z.object({
  action: z.enum(["retry", "cancel"]),
  jobId: z.string().min(1),
});

export async function GET() {
  try {
    await requirePlatformAccess();
    const jobs = await prisma.failedJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return Response.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        organisationId: j.organisationId,
        queue: j.queue,
        jobName: j.jobName,
        error: j.error,
        attempts: j.attempts,
        payload: j.payload,
        createdAt: j.createdAt.toISOString(),
        resolvedAt: j.resolvedAt?.toISOString() ?? null,
        status: j.resolvedAt ? "resolved" : "open",
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = schema.parse(await req.json());
    const job = await prisma.failedJob.findUnique({ where: { id: body.jobId } });
    if (!job) return jsonError("Job not found", 404);

    if (body.action === "cancel") {
      await prisma.failedJob.update({
        where: { id: job.id },
        data: { resolvedAt: new Date() },
      });
      await writeAuditLog({
        organisationId: job.organisationId || session.organisationId,
        userId: session.userId,
        action: "failed_job.cancel",
        entityType: "FailedJob",
        entityId: job.id,
      });
      return Response.json({ ok: true });
    }

    // Idempotent retry: mark resolved and record a retry audit with a stable key.
    // Actual re-enqueue is best-effort via cron-compatible marker in payload.
    if (job.resolvedAt) {
      return Response.json({ ok: true, duplicate: true, message: "Already resolved" });
    }

    const retryKey = hashForIdempotency(`retry:${job.id}:${job.attempts}`);
    await prisma.failedJob.update({
      where: { id: job.id },
      data: {
        attempts: { increment: 1 },
        resolvedAt: new Date(),
        payload: {
          ...(typeof job.payload === "object" && job.payload ? (job.payload as object) : {}),
          retryRequestedAt: new Date().toISOString(),
          retryKey,
          retryBy: session.userId,
        },
      },
    });

    await writeAuditLog({
      organisationId: job.organisationId || session.organisationId,
      userId: session.userId,
      action: "failed_job.retry",
      entityType: "FailedJob",
      entityId: job.id,
      metadata: { retryKey, queue: job.queue, jobName: job.jobName },
    });

    return Response.json({ ok: true, retryKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
