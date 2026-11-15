import { z } from "zod";
import { GoalCategory, GoalStatus } from "@prisma/client";
import { jsonError, requirePermission, requirePermissionForMutation, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";
import {
  attachKpiTarget,
  updateKpiTarget,
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
import { InvalidGoalTransitionError } from "@/services/goals/state";
import { currencyOfUnit, moneyUnitFor, statusLabel, unitLabel } from "@/lib/customer-labels";
import { getDefaultDealCurrency } from "@/services/crm-v2";

const FIELD_LABELS: Record<string, string> = {
  action: "Action",
  name: "Name",
  description: "Description",
  category: "Category",
  priority: "Priority",
  goalId: "Goal",
  status: "Status",
  key: "KPI key",
  unit: "Unit",
  calculatorKey: "KPI measure",
  kpiDefinitionId: "KPI",
  targetValue: "Target",
  baselineValue: "Baseline",
  deadlineAt: "Deadline",
};

/** One plain-English sentence for the first validation problem — never raw Zod JSON. */
function readableGoalValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Please check the form and try again.";
  const field = String(issue.path[0] ?? "");
  const label = FIELD_LABELS[field] ?? "This field";
  switch (issue.code) {
    case "too_small":
      if (issue.type === "string") return `${label} is required.`;
      return `${label} must be at least ${issue.minimum}.`;
    case "too_big":
      if (issue.type === "string") return `${label} must be ${issue.maximum} characters or fewer.`;
      return `${label} must be ${issue.maximum} or less.`;
    case "invalid_type":
      if (issue.received === "undefined" || issue.received === "null") return `${label} is required.`;
      if (issue.expected === "number" || issue.expected === "integer") return `${label} must be a number.`;
      return `${label} isn't valid.`;
    case "invalid_enum_value":
      return `${label} isn't one of the available options.`;
    case "invalid_string":
      return issue.validation === "datetime" ? `${label} must be a valid date.` : `${label} isn't valid.`;
    default:
      return `${label} isn't valid.`;
  }
}

/** Map service errors to messages a person can act on. */
function readableGoalError(error: unknown): { message: string; status: number } {
  if (error instanceof z.ZodError) {
    return { message: readableGoalValidationError(error), status: 400 };
  }
  if (error instanceof SyntaxError) {
    return { message: "The request couldn't be read. Please try again.", status: 400 };
  }
  if (error instanceof InvalidGoalTransitionError) {
    const from = statusLabel(error.from).toLowerCase();
    const article = /^[aeiou]/.test(from) ? "An" : "A";
    return {
      message: `${article} ${from} goal can't be changed to ${statusLabel(error.to).toLowerCase()}.`,
      status: 409,
    };
  }
  if (error instanceof Error && error.message.startsWith("Goal cannot be marked ACHIEVED")) {
    return {
      message: "A goal can only be marked achieved once a KPI target shows it has been met.",
      status: 409,
    };
  }
  if ((error as { code?: unknown } | null)?.code === "P2002") {
    return { message: "This goal already has a target for that KPI.", status: 409 };
  }
  const message = error instanceof Error ? error.message : "Failed";
  const unitMismatch = /^Unit mismatch: (\S+) vs (\S+)$/.exec(message);
  if (unitMismatch) {
    return {
      message: `The target's unit (${unitLabel(unitMismatch[1]!)}) doesn't match this KPI (${unitLabel(unitMismatch[2]!)}).`,
      status: 400,
    };
  }
  if (/^(Goal|KPI definition|KPI target) not found$/.test(message)) return { message, status: 404 };
  if (message.startsWith("Unknown KPI calculator")) {
    return { message: "That KPI measure isn't available.", status: 400 };
  }
  return { message, status: 400 };
}

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
    const [goals, mainCurrency] = await Promise.all([
      listGoals(session.organisationId),
      getDefaultDealCurrency(session.organisationId),
    ]);
    return Response.json({
      goals,
      // Money targets are offered in the currency most of this workspace's deals use.
      mainCurrency,
      calculators: Object.values(KPI_CALCULATORS).map((c) => ({
        key: c.key,
        unit: currencyOfUnit(c.unit) ? moneyUnitFor(mainCurrency) : c.unit,
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
    "update_target",
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
  targetId: z.string().optional(),
  targetValue: z.number().finite().optional(),
  baselineValue: z.number().optional(),
  deadlineAt: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("agent:manage", req, raw);
    const body = createSchema.parse(raw);

    if (body.action === "create_goal") {
      if (!body.name?.trim()) return jsonError("Give the goal a name.", 400);
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
      if (!body.goalId) return jsonError("Choose a goal.", 400);
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
      if (!body.goalId || !body.status) return jsonError("Choose a goal and a status.", 400);
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
        return jsonError("Choose a KPI measure.", 400);
      }
      // A revenue KPI in another currency is its own KPI (existing £ ones keep their history).
      const currency = currencyOfUnit(body.unit);
      const key =
        currency && currency !== "GBP" && !body.key.endsWith(`_${currency.toLowerCase()}`)
          ? `${body.key}_${currency.toLowerCase()}`
          : body.key;
      const kpi = await createKpiDefinition({
        organisationId: session.organisationId,
        key,
        name: body.name,
        unit: body.unit,
        calculatorKey: body.calculatorKey,
        description: body.description,
      });
      return Response.json({ kpi });
    }
    if (body.action === "attach_target") {
      if (!body.goalId || !body.kpiDefinitionId || body.targetValue == null || !body.unit) {
        return jsonError("Choose a goal, a KPI and a target value.", 400);
      }
      // Stored units: <CURRENCY>_CENTS in pence/cents, RATE as a 0–1 fraction (see formatKpiValue).
      if (body.targetValue < 0) return jsonError("Target can't be negative.", 400);
      if (body.unit === "RATE" && body.targetValue > 1) {
        return jsonError("Rate targets must be between 0% and 100%.", 400);
      }
      const target = await attachKpiTarget({
        organisationId: session.organisationId,
        goalId: body.goalId,
        kpiDefinitionId: body.kpiDefinitionId,
        targetValue: body.targetValue,
        baselineValue: body.baselineValue,
        unit: body.unit,
        currency: currencyOfUnit(body.unit) ?? undefined,
        deadlineAt: body.deadlineAt ? new Date(body.deadlineAt) : undefined,
      });
      return Response.json({ target });
    }
    if (body.action === "update_target") {
      if (!body.targetId || body.targetValue == null) {
        return jsonError("Choose a target and enter its new value.", 400);
      }
      if (body.targetValue < 0) return jsonError("Target can't be negative.", 400);
      const target = await updateKpiTarget({
        organisationId: session.organisationId,
        targetId: body.targetId,
        targetValue: body.targetValue,
      });
      return Response.json({ target });
    }
    if (body.action === "refresh_kpi") {
      if (!body.kpiDefinitionId) return jsonError("Choose a KPI.", 400);
      const snapshot = await refreshKpiFromCalculator({
        organisationId: session.organisationId,
        kpiDefinitionId: body.kpiDefinitionId,
      });
      return Response.json({ snapshot });
    }
    if (body.action === "create_initiative") {
      if (!body.name?.trim()) return jsonError("Give the initiative a name.", 400);
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
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    const readable = readableGoalError(error);
    return jsonError(readable.message, readable.status);
  }
}
