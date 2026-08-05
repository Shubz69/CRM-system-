import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

const ruleSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  triggerType: z.string().trim().min(1).max(100).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  actions: z.array(z.record(z.string(), z.unknown())).optional(),
  isActive: z.boolean().optional(),
});

export async function GET() {
  try {
    const session = await requirePermission("automations:manage");
    const rules = await prisma.automationRule.findMany({
      where: { organisationId: session.organisationId },
      include: {
        executions: { orderBy: { createdAt: "desc" }, take: 5 },
      },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json({ rules });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requirePermission("automations:manage");
    const body = ruleSchema.required({ name: true, triggerType: true, actions: true }).parse(await req.json());
    const rule = await prisma.automationRule.create({
      data: { organisationId: session.organisationId, name: body.name, triggerType: body.triggerType, conditions: (body.conditions ?? {}) as Prisma.InputJsonValue, actions: body.actions as Prisma.InputJsonValue, isActive: body.isActive ?? true },
    });
    return Response.json({ rule }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 400);
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await requirePermission("automations:manage");
    const body = ruleSchema.extend({ id: z.string() }).parse(await req.json());
    const { id, conditions, actions, ...rest } = body;
    const data = { ...rest, ...(conditions ? { conditions: conditions as Prisma.InputJsonValue } : {}), ...(actions ? { actions: actions as Prisma.InputJsonValue } : {}) };
    const result = await prisma.automationRule.updateMany({ where: { id, organisationId: session.organisationId }, data });
    if (!result.count) return jsonError("Automation rule not found", 404);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 400);
  }
}
