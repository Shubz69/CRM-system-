import { prisma } from "@/lib/db";
import {
  requirePermission,
  requirePermissionForMutation,
  jsonError,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  buildWorkflowSteps,
  compileNaturalLanguageToWorkflow,
  createRuleFromWorkflow,
} from "@/services/automation-os";

const ruleSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  triggerType: z.string().trim().min(1).max(100).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  actions: z.array(z.record(z.string(), z.unknown())).optional(),
  isActive: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  naturalLanguage: z.string().max(4000).optional(),
  description: z.string().max(2000).optional(),
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
    return Response.json({ organisationId: session.organisationId, rules });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const session = await requirePermissionForMutation(
      "automations:manage",
      req,
      body && typeof body === "object" ? (body as Record<string, unknown>) : null,
    );

    // NL compile + optional create
    if (body?.action === "compile") {
      const nl = z.string().min(1).max(4000).parse(body.naturalLanguage);
      const workflow = compileNaturalLanguageToWorkflow(nl);
      return Response.json({ workflow });
    }

    if (body?.action === "create_from_nl") {
      const nl = z.string().min(1).max(4000).parse(body.naturalLanguage);
      const name = z.string().min(1).max(200).parse(body.name ?? "NL automation");
      const workflow = compileNaturalLanguageToWorkflow(nl);
      const id = await createRuleFromWorkflow({
        organisationId: session.organisationId,
        name,
        workflow,
        description: body.description,
        isActive: false,
      });
      return Response.json(
        {
          id,
          organisationId: session.organisationId,
          workflow,
          isActive: false,
        },
        { status: 201 },
      );
    }

    const parsed = ruleSchema
      .required({ name: true, triggerType: true, actions: true })
      .parse(body);
    const conditions = parsed.conditions ?? {};
    const actions = parsed.actions ?? [];
    const requiresApproval =
      parsed.requiresApproval ??
      actions.some((a) =>
        ["send_follow_up", "schedule_follow_up", "send_booking_link", "send_message", "publish_content"].includes(
          String(a.type),
        ),
      );
    const workflow = {
      version: 1 as const,
      triggerType: parsed.triggerType,
      conditions,
      actions,
      steps: buildWorkflowSteps({
        triggerType: parsed.triggerType,
        conditions,
        actions,
        requiresApproval,
      }),
      requiresApproval,
    };

    const rule = await prisma.automationRule.create({
      data: {
        organisationId: session.organisationId,
        name: parsed.name,
        description: parsed.description ?? null,
        triggerType: parsed.triggerType,
        conditions: conditions as Prisma.InputJsonValue,
        actions: actions as Prisma.InputJsonValue,
        workflow: workflow as unknown as Prisma.InputJsonValue,
        naturalLanguageSource: parsed.naturalLanguage ?? null,
        requiresApproval,
        isActive: parsed.isActive ?? true,
      },
    });
    return Response.json({ rule, organisationId: session.organisationId }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 400);
  }
}

export async function PATCH(req: Request) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation(
      "automations:manage",
      req,
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null,
    );
    const body = ruleSchema.extend({ id: z.string() }).parse(raw);
    const { id, conditions, actions, naturalLanguage: _nl, ...rest } = body;
    const data: Prisma.AutomationRuleUpdateManyMutationInput = { ...rest };
    if (conditions) data.conditions = conditions as Prisma.InputJsonValue;
    if (actions) {
      data.actions = actions as Prisma.InputJsonValue;
      const triggerType = body.triggerType;
      if (triggerType) {
        const requiresApproval =
          body.requiresApproval ??
          actions.some((a) =>
            ["send_follow_up", "schedule_follow_up", "send_booking_link", "send_message", "publish_content"].includes(
              String(a.type),
            ),
          );
        data.requiresApproval = requiresApproval;
        data.workflow = {
          version: 1,
          triggerType,
          conditions: conditions ?? {},
          actions,
          steps: buildWorkflowSteps({
            triggerType,
            conditions: (conditions ?? {}) as Record<string, unknown>,
            actions,
            requiresApproval,
          }),
          requiresApproval,
        } as unknown as Prisma.InputJsonValue;
      }
    }
    const result = await prisma.automationRule.updateMany({
      where: { id, organisationId: session.organisationId },
      data,
    });
    if (!result.count) return jsonError("Automation rule not found", 404);
    return Response.json({ ok: true, organisationId: session.organisationId });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 400);
  }
}
