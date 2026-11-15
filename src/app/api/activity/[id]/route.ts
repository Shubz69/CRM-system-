import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermissionForMutation } from "@/lib/session";
import { readJsonObject, RouteError, routeErrorResponse } from "@/app/api/pipeline/_lib/http";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  completed: z.boolean({
    required_error: "completed is required",
    invalid_type_error: "completed must be true or false",
  }),
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** PATCH /api/activity/[id] — mark a task done (or not done again). */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const raw = await readJsonObject(req);
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const { completed } = patchSchema.parse(raw);
    const { id } = await params;

    const activity = await prisma.crmActivity.findFirst({
      where: { id, organisationId: session.organisationId },
      select: { id: true, kind: true, completedAt: true, metadata: true },
    });
    if (!activity) throw new RouteError(404, "Activity not found");
    if (activity.kind !== "task") throw new RouteError(400, "Only tasks can be marked done");

    // Completing twice keeps the first completion time.
    const completedAt = completed ? (activity.completedAt ?? new Date()) : null;
    const metadata = { ...asRecord(activity.metadata) };
    if (completed) {
      if (!activity.completedAt) metadata.completedByUserId = session.userId;
    } else {
      delete metadata.completedByUserId;
    }

    await prisma.crmActivity.updateMany({
      where: { id: activity.id, organisationId: session.organisationId },
      data: { completedAt, metadata: metadata as Prisma.InputJsonValue },
    });

    return Response.json({
      ok: true,
      id: activity.id,
      completedAt: completedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return routeErrorResponse(error, "Updating the task");
  }
}
