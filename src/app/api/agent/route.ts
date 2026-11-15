import { NextRequest } from "next/server";
import { z } from "zod";
import { readableZodError } from "@/lib/readable-zod";
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
    if (message.startsWith("Forbidden")) {
      return jsonError("You don't have permission to manage the AI agent.", 403);
    }
    return jsonError("Couldn't load the AI agent settings. Try again.", 500);
  }
}

/** True for an absolute http(s) URL with a host — what a lead can actually open. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

const BOOKING_URL_INVALID =
  "Booking URL must be a full web address starting with https:// (or http://), or left empty.";

const updateSchema = z.object({
  aiProvider: z.enum(["mock", "openai", "anthropic"]).optional(),
  model: z.string().optional(),
  brandTone: z.string().optional(),
  formality: z.string().optional(),
  responseLength: z.string().optional(),
  emojiUsage: z.string().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  // Nullable columns: new workspaces have no booking URL / prompt extra yet, and the page sends null.
  // Empty clears the link; anything else must be a real http(s) URL (it is sent to leads).
  bookingUrl: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value))
    .refine((value) => value == null || isHttpUrl(value), { message: BOOKING_URL_INVALID }),
  maxFollowUps: z.number().int().min(0).max(10).optional(),
  followUpDelaysMinutes: z.array(z.number()).optional(),
  // One question per entry; tolerate entries that still contain line breaks and drop blanks.
  qualificationQuestions: z
    .array(z.string())
    .optional()
    .transform((questions) =>
      questions
        ?.flatMap((question) => question.split(/\r?\n/))
        .map((question) => question.trim())
        .filter(Boolean),
    ),
  scoringRules: z.record(z.unknown()).optional(),
  restrictedTopics: z.array(z.string()).optional(),
  systemPromptExtra: z.string().nullable().optional(),
});

const AGENT_FIELD_LABELS: Record<string, string> = {
  aiProvider: "AI provider",
  model: "Model",
  brandTone: "Brand tone",
  formality: "Formality",
  responseLength: "Response length",
  emojiUsage: "Emoji use",
  confidenceThreshold: "Confidence threshold",
  bookingUrl: "Booking URL",
  maxFollowUps: "Maximum follow-ups",
  followUpDelaysMinutes: "Follow-up delays",
  qualificationQuestions: "Qualification questions",
  scoringRules: "Scoring rules",
  restrictedTopics: "Restricted topics",
  systemPromptExtra: "Extra instructions",
};

function readableValidationError(error: z.ZodError): string {
  return readableZodError(error, AGENT_FIELD_LABELS, "Check the agent settings and try again.");
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
    if (message.startsWith("Forbidden")) {
      return jsonError("You don't have permission to manage the AI agent.", 403);
    }
    return jsonError("Couldn't save the AI agent settings. Try again.", 500);
  }
}
