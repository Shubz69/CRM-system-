import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { setOrganisationPreference } from "@/services/agent-memory";
import {
  getOrganisationAiBudgetStatus,
  setOrganisationAiBudget,
} from "@/services/ai-spend-gate";
import { AI_BUDGET_WARNING_PREF_KEY } from "@/services/beta-workspace";

const patchSchema = z.object({
  organisationId: z.string().min(1),
  monthlyCapCents: z.number().int().min(0).nullable(),
  warningThresholdCents: z.number().int().min(0).nullable().optional(),
});

export async function GET(req: NextRequest) {
  try {
    await requirePlatformAccess();
    const organisationId = req.nextUrl.searchParams.get("organisationId");
    if (!organisationId) return jsonError("organisationId required", 400);
    const status = await getOrganisationAiBudgetStatus(organisationId);
    return Response.json({ status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = patchSchema.parse(await req.json());

    const budget = await setOrganisationAiBudget({
      organisationId: body.organisationId,
      monthlyCapCents: body.monthlyCapCents,
    });

    if (body.warningThresholdCents !== undefined) {
      await setOrganisationPreference({
        organisationId: body.organisationId,
        key: AI_BUDGET_WARNING_PREF_KEY,
        value: { cents: body.warningThresholdCents },
        updatedByUserId: session.userId,
      });
    }

    await writeAuditLog({
      organisationId: body.organisationId,
      userId: session.userId,
      action: "workspace.ai_budget.update",
      entityType: "OrganisationAiBudget",
      entityId: budget.id,
      metadata: {
        monthlyCapCents: body.monthlyCapCents,
        warningThresholdCents: body.warningThresholdCents ?? null,
      },
    });

    const status = await getOrganisationAiBudgetStatus(body.organisationId);
    return Response.json({ ok: true, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) {
      return jsonError(error.errors[0]?.message || "Invalid request", 400);
    }
    return jsonError(message, 500);
  }
}
