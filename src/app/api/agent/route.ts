import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";

function customerFacingAgentConfig<T extends Record<string, unknown>>(config: T | null) {
  if (!config) return null;
  const { aiProvider: _p, model: _m, ...rest } = config as T & {
    aiProvider?: unknown;
    model?: unknown;
  };
  void _p;
  void _m;
  return rest;
}

export async function GET() {
  try {
    const session = await requirePermission("agent:manage");
    const config = await prisma.agentConfiguration.findFirst({
      where: { organisationId: session.organisationId, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json({ config: customerFacingAgentConfig(config as Record<string, unknown> | null) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

const updateSchema = z.object({
  aiProvider: z.enum(["mock", "openai", "anthropic"]).optional(),
  model: z.string().optional(),
  brandTone: z.string().optional(),
  formality: z.string().optional(),
  responseLength: z.string().optional(),
  emojiUsage: z.string().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  // Nullable columns: new workspaces have no booking URL / prompt extra yet, and the page sends null.
  bookingUrl: z.string().trim().max(2000).nullable().optional(),
  maxFollowUps: z.number().int().min(0).max(10).optional(),
  followUpDelaysMinutes: z.array(z.number()).optional(),
  qualificationQuestions: z.array(z.string()).optional(),
  scoringRules: z.record(z.unknown()).optional(),
  restrictedTopics: z.array(z.string()).optional(),
  systemPromptExtra: z.string().nullable().optional(),
});

function readableValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Check the agent settings and try again.";
  const field = issue.path.join(".");
  return field ? `Invalid ${field}: ${issue.message}` : issue.message;
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = updateSchema.parse(await req.json());
    const existing = await prisma.agentConfiguration.findFirst({
      where: { organisationId: session.organisationId, isActive: true },
    });
    if (!existing) return jsonError("No agent configuration found", 404);

    // Workspace users may update behaviour preferences only — not provider/model routing.
    const { aiProvider: _aiProvider, model: _model, ...behaviour } = body;
    void _aiProvider;
    void _model;

    const config = await prisma.agentConfiguration.update({
      where: { id: existing.id },
      data: {
        ...behaviour,
        scoringRules: behaviour.scoringRules
          ? (JSON.parse(JSON.stringify(behaviour.scoringRules)) as object)
          : undefined,
        followUpDelaysMinutes: behaviour.followUpDelaysMinutes
          ? (JSON.parse(JSON.stringify(behaviour.followUpDelaysMinutes)) as object)
          : undefined,
        qualificationQuestions: behaviour.qualificationQuestions
          ? (JSON.parse(JSON.stringify(behaviour.qualificationQuestions)) as object)
          : undefined,
        restrictedTopics: behaviour.restrictedTopics
          ? (JSON.parse(JSON.stringify(behaviour.restrictedTopics)) as object)
          : undefined,
      },
    });
    return Response.json({
      config: customerFacingAgentConfig(config as unknown as Record<string, unknown>),
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError(readableValidationError(error), 400);
    if (error instanceof SyntaxError) return jsonError("Invalid JSON body", 400);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
