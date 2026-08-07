import { NextRequest } from "next/server";
import { z } from "zod";
import { AutopilotMode } from "@prisma/client";
import { jsonError, requirePermission, requireSession } from "@/lib/session";
import {
  DEFAULT_AUTOPILOT_CONFIG,
  getAutopilotTodayStats,
  getOrganisationAutopilot,
  parseAutopilotConfig,
  setAutopilotMode,
  type AutopilotCapabilityMode,
} from "@/services/autopilot";

const capabilityMode = z.enum(["automatic", "approval_required", "disabled"]);

const patchSchema = z.object({
  mode: z.nativeEnum(AutopilotMode).optional(),
  config: z
    .object({
      aiResponses: capabilityMode.optional(),
      qualification: capabilityMode.optional(),
      pipelineManagement: capabilityMode.optional(),
      leadScoring: capabilityMode.optional(),
      followUps: capabilityMode.optional(),
      booking: capabilityMode.optional(),
      contactEnrichment: capabilityMode.optional(),
      insights: capabilityMode.optional(),
      contentRecommendations: capabilityMode.optional(),
    })
    .optional(),
  reason: z.string().optional(),
});

export async function GET() {
  try {
    const session = await requireSession();
    const org = await getOrganisationAutopilot(session.organisationId);
    if (!org) return jsonError("Organisation not found", 404);
    const stats = await getAutopilotTodayStats(session.organisationId);
    return Response.json({
      mode: org.autopilotMode,
      status: org.status,
      config: org.config,
      defaults: DEFAULT_AUTOPILOT_CONFIG,
      stats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = patchSchema.parse(await req.json());
    const current = await getOrganisationAutopilot(session.organisationId);
    if (!current) return jsonError("Organisation not found", 404);

    const nextMode = body.mode ?? current.autopilotMode;
    const result = await setAutopilotMode({
      organisationId: session.organisationId,
      userId: session.userId,
      mode: nextMode,
      config: body.config as Partial<Record<string, AutopilotCapabilityMode>> | undefined,
      reason: body.reason,
    });

    return Response.json({ ok: true, ...result, parsed: parseAutopilotConfig(result.config) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
