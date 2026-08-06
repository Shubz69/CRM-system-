import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export async function recordFailedJob(input: {
  organisationId?: string | null;
  queue: string;
  jobName: string;
  payload?: unknown;
  error: string;
  attempts?: number;
}) {
  try {
    return await prisma.failedJob.create({
      data: {
        organisationId: input.organisationId ?? null,
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
