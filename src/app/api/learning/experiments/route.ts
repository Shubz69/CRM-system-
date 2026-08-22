import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import {
  completeExperiment,
  createExperiment,
  startExperiment,
} from "@/services/learning-os";

export async function GET() {
  try {
    const session = await requirePermission("insights:read");
    const experiments = await prisma.experiment.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return Response.json({ experiments });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const createSchema = z.object({
  action: z.literal("create").optional(),
  name: z.string().min(1),
  hypothesis: z.string().min(1),
  primaryMetric: z.string().min(1),
  variants: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .min(1),
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), id: z.string().min(1) }),
  z.object({
    action: z.literal("complete"),
    id: z.string().min(1),
    sampleSize: z.number().int().min(0),
    metricByVariant: z.record(z.number()).optional(),
    winnerKey: z.string().optional().nullable(),
    message: z.string().optional(),
  }),
]);

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = createSchema.parse(await req.json());
    const experiment = await createExperiment({
      organisationId: session.organisationId,
      name: body.name,
      hypothesis: body.hypothesis,
      primaryMetric: body.primaryMetric,
      variants: body.variants,
      createdByUserId: session.userId,
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "learning.experiment_created",
      entityType: "Experiment",
      entityId: experiment.id,
    });
    return Response.json({ experiment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = patchSchema.parse(await req.json());
    if (body.action === "start") {
      const experiment = await startExperiment({
        organisationId: session.organisationId,
        experimentId: body.id,
      });
      return Response.json({ experiment });
    }
    const experiment = await completeExperiment({
      organisationId: session.organisationId,
      experimentId: body.id,
      sampleSize: body.sampleSize,
      metricByVariant: body.metricByVariant,
      winnerKey: body.winnerKey,
      message: body.message,
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "learning.experiment_completed",
      entityType: "Experiment",
      entityId: experiment.id,
      metadata: { sampleSize: body.sampleSize },
    });
    return Response.json({ experiment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
