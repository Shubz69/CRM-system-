import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";

export async function GET() {
  try {
    const session = await requirePermission("agent:manage");
    const config = await prisma.agentConfiguration.findFirst({
      where: { organisationId: session.organisationId, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json({ config });
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
  bookingUrl: z.string().optional(),
  maxFollowUps: z.number().int().min(0).max(10).optional(),
  followUpDelaysMinutes: z.array(z.number()).optional(),
  qualificationQuestions: z.array(z.string()).optional(),
  scoringRules: z.record(z.unknown()).optional(),
  restrictedTopics: z.array(z.string()).optional(),
  systemPromptExtra: z.string().optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = updateSchema.parse(await req.json());
    const existing = await prisma.agentConfiguration.findFirst({
      where: { organisationId: session.organisationId, isActive: true },
    });
    if (!existing) return jsonError("No agent configuration found", 404);

    const config = await prisma.agentConfiguration.update({
      where: { id: existing.id },
      data: {
        ...body,
        scoringRules: body.scoringRules
          ? (JSON.parse(JSON.stringify(body.scoringRules)) as object)
          : undefined,
        followUpDelaysMinutes: body.followUpDelaysMinutes
          ? (JSON.parse(JSON.stringify(body.followUpDelaysMinutes)) as object)
          : undefined,
        qualificationQuestions: body.qualificationQuestions
          ? (JSON.parse(JSON.stringify(body.qualificationQuestions)) as object)
          : undefined,
        restrictedTopics: body.restrictedTopics
          ? (JSON.parse(JSON.stringify(body.restrictedTopics)) as object)
          : undefined,
      },
    });
    return Response.json({ config });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
