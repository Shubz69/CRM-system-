import { NextRequest } from "next/server";
import { z } from "zod";
import { getAiModels, getAiProviderDefaults, DEFAULT_TASK_TIERS } from "@/lib/ai-models";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { getAiRouterConfig, saveAiRouterConfig } from "@/services/ai-router";
import { writeAuditLog } from "@/services/audit";
import { prisma } from "@/lib/db";

const patchSchema = z.object({
  taskTiers: z.record(z.enum(["default", "economy", "advanced"])).optional(),
  escalateOnLowConfidence: z.boolean().optional(),
  lowConfidenceThreshold: z.number().min(0).max(1).optional(),
  highValueScoreThreshold: z.number().min(0).max(100).optional(),
});

export async function GET() {
  try {
    await requirePlatformAccess();
    const router = await getAiRouterConfig();
    const models = getAiModels();
    const defaults = getAiProviderDefaults();
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const [today, failures, successes, recent] = await Promise.all([
      prisma.aiExecution.count({ where: { createdAt: { gte: start }, provider: "anthropic" } }),
      prisma.aiExecution.count({
        where: { createdAt: { gte: start }, provider: "anthropic", success: false },
      }),
      prisma.aiExecution.count({
        where: { createdAt: { gte: start }, provider: "anthropic", success: true },
      }),
      prisma.aiExecution.findMany({
        where: { provider: "anthropic", success: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      }),
    ]);

    const avgLatency = await prisma.aiExecution.aggregate({
      where: { provider: "anthropic", createdAt: { gte: start }, latencyMs: { not: null } },
      _avg: { latencyMs: true },
    });

    return Response.json({
      primaryProvider: "anthropic",
      openaiOptional: true,
      openaiRequired: false,
      models,
      defaults: {
        maxTokens: defaults.maxTokens,
        timeoutMs: defaults.timeoutMs,
        retries: defaults.retries,
        temperature: defaults.temperature,
      },
      defaultTaskTiers: DEFAULT_TASK_TIERS,
      router,
      health: {
        configured: Boolean(process.env.ANTHROPIC_API_KEY),
        requestsToday: today,
        successToday: successes,
        failuresToday: failures,
        failureRate: today === 0 ? 0 : Math.round((failures / today) * 1000) / 10,
        avgLatencyMs: Math.round(avgLatency._avg.latencyMs || 0),
        lastSuccessAt: recent[0]?.createdAt?.toISOString() ?? null,
      },
    });
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
    const saved = await saveAiRouterConfig({
      taskTiers: body.taskTiers as never,
      escalateOnLowConfidence: body.escalateOnLowConfidence,
      lowConfidenceThreshold: body.lowConfidenceThreshold,
      highValueScoreThreshold: body.highValueScoreThreshold,
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "ai.router_config_change",
      entityType: "SystemSetting",
      entityId: "ai.router",
      metadata: saved,
    });
    return Response.json({ ok: true, router: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
