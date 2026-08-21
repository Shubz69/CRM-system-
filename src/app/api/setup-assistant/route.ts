import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { getAiProvider } from "@/adapters/ai";
import { resolveModelForTier } from "@/lib/ai-models";
import { jsonError, requirePermission } from "@/lib/session";
import { recordAiExecution } from "@/services/ai-execution";
import { writeAuditLog } from "@/services/audit";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";

const proposeSchema = z.object({
  action: z.literal("propose"),
  businessDescription: z.string().min(20).max(8000),
});

const approveSchema = z.object({
  action: z.literal("approve"),
  proposal: z.record(z.unknown()),
});

const proposalShape = z.object({
  reply: z.string().optional(),
  knowledgeStructure: z.array(z.object({ title: z.string(), category: z.string(), content: z.string() })).optional(),
  qualificationFields: z
    .array(z.object({ key: z.string(), label: z.string(), description: z.string().optional() }))
    .optional(),
  qualificationQuestions: z.array(z.string()).optional(),
  scoringRules: z.record(z.unknown()).optional(),
  bookingThreshold: z.number().optional(),
  disqualificationRules: z.array(z.unknown()).optional(),
  tone: z.string().optional(),
  followUpDelaysMinutes: z.array(z.number()).optional(),
  handoverRules: z.record(z.unknown()).optional(),
  pipelineStages: z.array(z.object({ name: z.string(), slug: z.string() })).optional(),
});

function humanizeSetupAiError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("api key is invalid") ||
    lower.includes("authentication_error") ||
    lower.includes("invalid x-api-key") ||
    (lower.includes("401") && lower.includes("anthropic"))
  ) {
    return "Claude isn’t configured correctly on the server (invalid Anthropic API key). An admin needs to update ANTHROPIC_API_KEY in Vercel and redeploy.";
  }
  if (lower.includes("anthropic") && (lower.includes("not configured") || lower.includes("missing"))) {
    return "Claude isn’t configured yet. Add ANTHROPIC_API_KEY in Vercel (or switch AI_PROVIDER), then redeploy.";
  }
  return message;
}

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = z.union([proposeSchema, approveSchema]).parse(await req.json());

    if (body.action === "propose") {
      const env = getEnv();
      if (!env.ANTHROPIC_API_KEY && (env.AI_PROVIDER || "anthropic") === "anthropic") {
        return jsonError(
          "Claude isn’t configured yet. Add ANTHROPIC_API_KEY in Vercel, then redeploy.",
          503,
        );
      }

      const provider = getAiProvider();
      const model = resolveModelForTier("default");
      const started = Date.now();
      const systemPrompt = `You are Claude, the Agent Desk Setup Assistant.
Given a business description, propose CRM configuration as JSON with keys:
knowledgeStructure (array of {title,category,content}),
qualificationFields (array of {key,label,description}),
qualificationQuestions (string array),
scoringRules (object),
bookingThreshold (number 0-100),
disqualificationRules (array),
tone (string),
followUpDelaysMinutes (number array),
handoverRules (object),
pipelineStages (array of {name,slug}),
reply (short summary for the user).
Return ONLY JSON. Do not invent fake customer data.`;

      let raw: unknown;
      try {
        raw = await provider.analyseConversation({
          model,
          systemPrompt,
          conversationTranscript: "",
          knowledgeContext: "",
          leadMessage: body.businessDescription,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "AI request failed";
        await recordAiExecution({
          organisationId: session.organisationId,
          provider: provider.name,
          model,
          taskType: "setup_assistant",
          feature: "setup_assistant",
          latencyMs: Date.now() - started,
          success: false,
          metadata: { mode: "propose", error: message.slice(0, 500) },
        });
        return jsonError(humanizeSetupAiError(message), 502);
      }

      let proposal: Record<string, unknown>;
      if (raw && typeof raw === "object" && "qualificationQuestions" in (raw as object)) {
        proposal = raw as Record<string, unknown>;
      } else if (raw && typeof raw === "object" && "reply" in (raw as object)) {
        proposal = {
          reply: (raw as { reply?: string }).reply,
          ...(raw as object),
        };
      } else {
        proposal = { reply: "Could not parse proposal", raw };
      }

      await recordAiExecution({
        organisationId: session.organisationId,
        provider: provider.name,
        model,
        taskType: "setup_assistant",
        feature: "setup_assistant",
        latencyMs: Date.now() - started,
        success: true,
        metadata: { mode: "propose" },
      });

      return Response.json({
        ok: true,
        message: "Here's what I've configured.",
        proposal,
        provider: provider.name,
        model,
      });
    }

    const parsed = proposalShape.safeParse(body.proposal);
    const proposal = parsed.success ? parsed.data : (body.proposal as z.infer<typeof proposalShape>);

    if (proposal.tone || proposal.qualificationQuestions || proposal.scoringRules || proposal.handoverRules) {
      const agent = await prisma.agentConfiguration.findFirst({
        where: { organisationId: session.organisationId, isActive: true },
      });
      if (agent) {
        await prisma.agentConfiguration.update({
          where: { id: agent.id },
          data: {
            aiProvider: "anthropic",
            model: resolveModelForTier("default"),
            brandTone: proposal.tone || agent.brandTone,
            qualificationQuestions: (proposal.qualificationQuestions ||
              agent.qualificationQuestions) as Prisma.InputJsonValue,
            scoringRules: (proposal.scoringRules || agent.scoringRules) as Prisma.InputJsonValue,
            handoverRules: (proposal.handoverRules || agent.handoverRules) as Prisma.InputJsonValue,
            followUpDelaysMinutes: (proposal.followUpDelaysMinutes ||
              agent.followUpDelaysMinutes) as Prisma.InputJsonValue,
            bookingConditions: (proposal.bookingThreshold
              ? { threshold: proposal.bookingThreshold }
              : agent.bookingConditions) as Prisma.InputJsonValue,
            disqualificationRules: (proposal.disqualificationRules ||
              agent.disqualificationRules) as Prisma.InputJsonValue,
          },
        });
      }
    }

    if (proposal.knowledgeStructure?.length) {
      for (const doc of proposal.knowledgeStructure.slice(0, 12)) {
        await prisma.knowledgeDocument.create({
          data: {
            organisationId: session.organisationId,
            title: doc.title.slice(0, 180),
            category: doc.category || "setup",
            content: doc.content,
            status: "ACTIVE",
          },
        });
      }
    }

    if (proposal.qualificationFields?.length) {
      for (const field of proposal.qualificationFields.slice(0, 20)) {
        await prisma.qualificationField.upsert({
          where: {
            organisationId_key: {
              organisationId: session.organisationId,
              key: field.key,
            },
          },
          create: {
            organisationId: session.organisationId,
            key: field.key,
            label: field.label,
            description: field.description,
          },
          update: {
            label: field.label,
            description: field.description,
          },
        });
      }
    }

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "ai.setup_approved",
      entityType: "Organisation",
      entityId: session.organisationId,
      metadata: { keys: Object.keys(proposal) },
    });

    return Response.json({ ok: true, message: "Setup approved and saved." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError(error.errors[0]?.message || "Invalid", 400);
    return jsonError(humanizeSetupAiError(message), 500);
  }
}
