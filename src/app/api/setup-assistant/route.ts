import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { getAiProvider } from "@/adapters/ai";
import { completeStructuredSafe, type SafeStructuredResult } from "@/adapters/ai/structured";
import { resolveModelForTier } from "@/lib/ai-models";
import { jsonError, requirePermission } from "@/lib/session";
import { recordAiExecution } from "@/services/ai-execution";
import { writeAuditLog } from "@/services/audit";
import { upsertKnowledgeDocument } from "@/services/knowledge";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { toCustomerAiError, CUSTOMER_AI_UNAVAILABLE } from "@/lib/customer-ai-errors";

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

type SetupProposal = z.infer<typeof proposalShape>;

/** Keys approve can actually save — a proposal with none of them is not a usable setup. */
const AGENT_KEYS = [
  "tone",
  "qualificationQuestions",
  "scoringRules",
  "handoverRules",
  "followUpDelaysMinutes",
  "bookingThreshold",
  "disqualificationRules",
] as const satisfies ReadonlyArray<keyof SetupProposal>;

function hasSavableContent(proposal: SetupProposal): boolean {
  return (
    AGENT_KEYS.some((key) => proposal[key] !== undefined) ||
    Boolean(proposal.knowledgeStructure?.length) ||
    Boolean(proposal.qualificationFields?.length)
  );
}

const PROPOSAL_UNUSABLE =
  "Agent Desk couldn't build a setup proposal from that description. Add a little more detail and try again.";

function humanizeSetupAiError(message: string): string {
  return toCustomerAiError(message);
}

const SETUP_ASSISTANT_TAG = "setup-assistant";
const MAX_TITLE_LENGTH = 180;

function withTitleSuffix(title: string, suffix: string): string {
  return `${title.slice(0, MAX_TITLE_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

/**
 * upsertKnowledgeDocument matches on title and overwrites what it finds, so a proposal doc
 * titled like a hand-written one ("Pricing") would replace it. Keep the plain title only when
 * every doc already using it came from the Setup Assistant (re-approving updates it);
 * otherwise save under "<title> (Setup Assistant)", numbered if that is taken by another doc.
 */
async function setupAssistantDocumentTitle(organisationId: string, title: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate =
      attempt === 0
        ? title
        : withTitleSuffix(title, ` (Setup Assistant${attempt > 1 ? ` ${attempt}` : ""})`);
    const sameTitle = await prisma.knowledgeDocument.findMany({
      where: { organisationId, title: candidate },
      select: { tags: true },
    });
    if (sameTitle.every((doc) => doc.tags.includes(SETUP_ASSISTANT_TAG))) return candidate;
  }
  return withTitleSuffix(title, ` (Setup Assistant ${Date.now().toString(36)})`);
}

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = z.union([proposeSchema, approveSchema]).parse(await req.json());

    if (body.action === "propose") {
      const env = getEnv();
      if (!env.ANTHROPIC_API_KEY && (env.AI_PROVIDER || "anthropic") === "anthropic") {
        return jsonError(CUSTOMER_AI_UNAVAILABLE, 503);
      }

      const provider = getAiProvider();
      const model = resolveModelForTier("default");
      const started = Date.now();
      const systemPrompt = `You are the Agent Desk Setup Assistant.
Given a business description, propose CRM configuration as JSON with keys:
knowledgeStructure (array of {title,category,content}; category one of business|pricing|sop|faq|tone|scripts),
qualificationFields (array of {key,label,description}; key in snake_case),
qualificationQuestions (string array),
scoringRules (object: {"weights": {businessFit, need, urgency, budget, authority, engagement, sentiment, buyingSignals}} with numbers 0-30),
bookingThreshold (number 0-100),
disqualificationRules (array),
tone (string),
followUpDelaysMinutes (number array),
handoverRules (object),
pipelineStages (array of {name,slug}),
reply (short summary for the user).
Return ONLY JSON. Do not invent fake customer data, prices or policies that are not in the description.`;

      const recordFailure = (message: string) =>
        recordAiExecution({
          organisationId: session.organisationId,
          provider: provider.name,
          model,
          taskType: "setup_assistant",
          feature: "setup_assistant",
          latencyMs: Date.now() - started,
          success: false,
          metadata: { mode: "propose", error: message.slice(0, 500) },
        });

      // Plain structured completion with the setup proposal's own schema. (analyseConversation
      // appends the inbound-message decision schema, so its output never matched this shape.)
      let result: SafeStructuredResult<SetupProposal>;
      try {
        result = await completeStructuredSafe(proposalShape, {
          organisationId: session.organisationId,
          provider,
          model,
          system: systemPrompt,
          prompt: `Business description:\n${body.businessDescription}`,
          temperature: 0.2,
          maxTokens: 4096,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "AI request failed";
        await recordFailure(message);
        return jsonError(humanizeSetupAiError(message), 502);
      }

      if (!result.ok || !hasSavableContent(result.data)) {
        const reason = result.ok ? "Proposal contained no configurable fields" : result.reason;
        await recordFailure(reason);
        const providerFailed = !result.ok && result.failureClass === "PROVIDER_FAILED";
        return jsonError(providerFailed ? humanizeSetupAiError(reason) : PROPOSAL_UNUSABLE, 502);
      }
      const proposal: SetupProposal = result.data;

      await recordAiExecution({
        organisationId: session.organisationId,
        provider: provider.name,
        model,
        taskType: "setup_assistant",
        feature: "setup_assistant",
        latencyMs: Date.now() - started,
        success: true,
        metadata: { mode: "propose", repaired: result.repaired },
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
    if (!parsed.success) {
      return jsonError(
        "This proposal isn't in the expected format — generate a new proposal and approve that.",
        400,
      );
    }
    const proposal = parsed.data;
    if (!hasSavableContent(proposal)) {
      return jsonError("Nothing to save in this proposal — generate a new one.", 400);
    }

    let agentUpdated = false;
    if (AGENT_KEYS.some((key) => proposal[key] !== undefined)) {
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
        agentUpdated = true;
      }
    }

    // Through the knowledge service so documents are chunked/embedded (retrievable) and
    // re-approving the same proposal updates the existing documents instead of duplicating them.
    // A same-titled doc the team wrote by hand is never overwritten (see setupAssistantDocumentTitle).
    let knowledgeDocuments = 0;
    for (const doc of proposal.knowledgeStructure?.slice(0, 12) ?? []) {
      const proposedTitle = doc.title.trim().slice(0, MAX_TITLE_LENGTH);
      const content = doc.content.trim();
      if (!proposedTitle || !content) continue;
      await upsertKnowledgeDocument({
        organisationId: session.organisationId,
        title: await setupAssistantDocumentTitle(session.organisationId, proposedTitle),
        category: doc.category.trim() || "setup",
        content,
        tags: [SETUP_ASSISTANT_TAG],
      });
      knowledgeDocuments += 1;
    }

    let qualificationFields = 0;
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
        qualificationFields += 1;
      }
    }

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "ai.setup_approved",
      entityType: "Organisation",
      entityId: session.organisationId,
      metadata: { keys: Object.keys(proposal), agentUpdated, knowledgeDocuments, qualificationFields },
    });

    return Response.json({
      ok: true,
      message: "Setup approved and saved.",
      saved: { agentUpdated, knowledgeDocuments, qualificationFields },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError(error.errors[0]?.message || "Invalid", 400);
    return jsonError(humanizeSetupAiError(message), 500);
  }
}
