import { z } from "zod";
import { GoalCategory, GoalStatus } from "@prisma/client";
import { jsonError, requirePermission } from "@/lib/session";
import {
  attachKpiTarget,
  createGoal,
  createKpiDefinition,
  createInitiative,
  getGoalForOrg,
  listGoals,
  listKpiHistory,
  refreshKpiFromCalculator,
  transitionGoalStatus,
  updateGoal,
} from "@/services/goals";
import { KPI_CALCULATORS } from "@/services/goals/calculators";

/**
 * GET /api/goals — list goals + optional calculators catalogue
 */
export async function GET(req: Request) {
  try {
    const session = await requirePermission("insights:read");
    const url = new URL(req.url);
    const goalId = url.searchParams.get("id");
    const kpiId = url.searchParams.get("kpiHistory");
    if (goalId) {
      const goal = await getGoalForOrg(session.organisationId, goalId);
      if (!goal) return jsonError("Not found", 404);
      return Response.json({ goal });
    }
    if (kpiId) {
      const history = await listKpiHistory(session.organisationId, kpiId);
      return Response.json({ history });
    }
    const goals = await listGoals(session.organisationId);
    return Response.json({
      goals,
      calculators: Object.values(KPI_CALCULATORS).map((c) => ({
        key: c.key,
        unit: c.unit,
        description: c.description,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const createSchema = z.object({
  action: z.enum([
    "create_goal",
    "update_goal",
    "transition",
    "create_kpi",
    "attach_target",
    "refresh_kpi",
    "create_initiative",
  ]),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  category: z.nativeEnum(GoalCategory).optional(),
  priority: z.number().int().optional(),
  goalId: z.string().optional(),
  status: z.nativeEnum(GoalStatus).optional(),
  evidenceMet: z.boolean().optional(),
  key: z.string().optional(),
  unit: z.string().optional(),
  calculatorKey: z.string().optional(),
  kpiDefinitionId: z.string().optional(),
  targetValue: z.number().optional(),
  baselineValue: z.number().optional(),
  deadlineAt: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  try {
    const session = await requirePermission("agent:manage");
    const body = createSchema.parse(await req.json());

    if (body.action === "create_goal") {
      if (!body.name) return jsonError("name required", 400);
      const goal = await createGoal({
        organisationId: session.organisationId,
        name: body.name,
        description: body.description,
        category: body.category,
        priority: body.priority,
        createdByUserId: session.userId,
      });
      return Response.json({ goal });
    }
    if (body.action === "update_goal") {
      if (!body.goalId) return jsonError("goalId required", 400);
      const goal = await updateGoal({
        organisationId: session.organisationId,
        goalId: body.goalId,
        name: body.name,
        description: body.description,
        category: body.category,
        priority: body.priority,
      });
      return Response.json({ goal });
    }
    if (body.action === "transition") {
      if (!body.goalId || !body.status) return jsonError("goalId and status required", 400);
      const goal = await transitionGoalStatus({
        organisationId: session.organisationId,
        goalId: body.goalId,
        to: body.status,
        actorUserId: session.userId,
        evidenceMet: body.evidenceMet,
      });
      return Response.json({ goal });
    }
    if (body.action === "create_kpi") {
      if (!body.key || !body.name || !body.unit || !body.calculatorKey) {
        return jsonError("key, name, unit, calculatorKey required", 400);
      }
      const kpi = await createKpiDefinition({
        organisationId: session.organisationId,
        key: body.key,
        name: body.name,
        unit: body.unit,
        calculatorKey: body.calculatorKey,
        description: body.description,
      });
      return Response.json({ kpi });
    }
    if (body.action === "attach_target") {
      if (!body.goalId || !body.kpiDefinitionId || body.targetValue == null || !body.unit) {
        return jsonError("goalId, kpiDefinitionId, targetValue, unit required", 400);
      }
      const target = await attachKpiTarget({
        organisationId: session.organisationId,
        goalId: body.goalId,
        kpiDefinitionId: body.kpiDefinitionId,
        targetValue: body.targetValue,
        baselineValue: body.baselineValue,
        unit: body.unit,
        deadlineAt: body.deadlineAt ? new Date(body.deadlineAt) : undefined,
      });
      return Response.json({ target });
    }
    if (body.action === "refresh_kpi") {
      if (!body.kpiDefinitionId) return jsonError("kpiDefinitionId required", 400);
      const snapshot = await refreshKpiFromCalculator({
        organisationId: session.organisationId,
        kpiDefinitionId: body.kpiDefinitionId,
      });
      return Response.json({ snapshot });
    }
    if (body.action === "create_initiative") {
      if (!body.name) return jsonError("name required", 400);
      const initiative = await createInitiative({
        organisationId: session.organisationId,
        name: body.name,
        description: body.description,
        goalId: body.goalId,
      });
      return Response.json({ initiative });
    }
    return jsonError("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
