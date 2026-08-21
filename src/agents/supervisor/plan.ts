import { z } from "zod";
import { ensureAgentsRegistered, hasAgent, listAgents } from "@/agents";
import { completeStructuredSafe } from "@/adapters/ai/structured";
import type { Clarification, OrgAgentContext, PlanResult } from "@/agents/supervisor/types";
import { agentPlanSchema } from "@/agents/supervisor/types";

const AMBIGUOUS_MARKERS = [
  /what (can|should) (you|i)/i,
  /help me/i,
  /not sure/i,
  /\?$/,
];

function extractQuotedOrRemainder(request: string, verbPattern: RegExp): string | null {
  const quoted = request.match(/[“"]([^”"]+)[”"]/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();

  const afterVerb = request.replace(verbPattern, "").trim();
  if (afterVerb.length >= 3) return afterVerb;
  return null;
}

function looksLikeEcho(request: string): boolean {
  return /\b(echo|repeat|say back|mirror)\b/i.test(request);
}

function looksLikeSummarise(request: string): boolean {
  return /\b(summaris[e]|summarize|summary|tl;?dr|shorten|condense)\b/i.test(request);
}

function looksLikeSocialListening(request: string): boolean {
  return /\b(social listening|what('?s| is) (trending|getting attention)|high[- ]engagement|hooks and formats|content themes|audience complaints)\b/i.test(
    request,
  );
}

function looksLikeResearch(request: string): boolean {
  if (looksLikeSocialListening(request)) return false;
  if (looksLikeImaging(request)) return false;
  return /\b(research|look up|find (out|sources|articles)|investigate|compare|competitive analysis|market scan)\b/i.test(
    request,
  );
}

function looksLikeImaging(request: string): boolean {
  return /\b(image|picture|photo|illustration|artwork|graphic|visual|make me something like|generate (an? )?(image|picture)|create (an? )?(image|picture|graphic)|reference image|based on (this|the) (image|picture|photo))\b/i.test(
    request,
  );
}

function isTooVague(request: string): boolean {
  const trimmed = request.trim();
  if (trimmed.length < 8) return true;
  if (
    AMBIGUOUS_MARKERS.some((re) => re.test(trimmed)) &&
    !looksLikeEcho(trimmed) &&
    !looksLikeSummarise(trimmed) &&
    !looksLikeResearch(trimmed) &&
    !looksLikeSocialListening(trimmed) &&
    !looksLikeImaging(trimmed)
  ) {
    return true;
  }
  if (
    !looksLikeEcho(trimmed) &&
    !looksLikeSummarise(trimmed) &&
    !looksLikeResearch(trimmed) &&
    !looksLikeSocialListening(trimmed) &&
    !looksLikeImaging(trimmed)
  ) {
    if (trimmed.split(/\s+/).length >= 40) return false;
    return true;
  }
  return false;
}

function clarificationFor(request: string): Clarification {
  const hasBody = request.trim().split(/\s+/).length >= 5;
  return {
    kind: "clarification",
    question: "What would you like me to do with this?",
    options: hasBody
      ? [
          "Summarise it into a short brief",
          "Repeat it back to me",
          "Research this topic with sources",
          "Create an image from a reference",
        ]
      : [
          "Summarise some text I'll paste next",
          "Research a topic for me",
          "Create an image from a reference",
          "I'm not sure — show me an example",
        ],
  };
}

function planEcho(text: string): PlanResult {
  return {
    kind: "plan",
    plan: {
      steps: [{ agentName: "echo", input: { text } }],
      plainEnglishPlan: "I'll repeat your message back so you can confirm it came through clearly.",
    },
  };
}

function planSummarise(text: string): PlanResult {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return {
    kind: "plan",
    plan: {
      steps: [{ agentName: "summarise", input: { text, maxSentences: 3 } }],
      plainEnglishPlan:
        words > 20
          ? `I'll read your ${words}-word text and write a short summary you can skim.`
          : "I'll write a short summary of what you shared.",
    },
  };
}

function planSummariseThenEcho(text: string): PlanResult {
  return {
    kind: "plan",
    plan: {
      steps: [
        { agentName: "summarise", input: { text, maxSentences: 3 } },
        { agentName: "echo", input: { text } },
      ],
      plainEnglishPlan:
        "I'll summarise your text into a short brief, then show you the original wording again.",
    },
  };
}

function planResearchPipeline(topic: string): PlanResult {
  const clean = topic.trim().slice(0, 2000);
  return {
    kind: "plan",
    plan: {
      steps: [
        { agentName: "research", input: { topic: clean } },
        { agentName: "analyst", input: { topic: clean } },
        { agentName: "critic", input: {} },
      ],
      plainEnglishPlan: `I'll research recent viral talk about “${clean.slice(0, 80)}”, pull example video/post links, write a short take + full brief, then flag what looks next on the algorithm.`,
    },
  };
}

function planSocialListeningPipeline(topic: string): PlanResult {
  const clean = topic.trim().slice(0, 2000);
  return {
    kind: "plan",
    plan: {
      steps: [
        { agentName: "social_listening", input: { topic: clean } },
        { agentName: "analyst", input: { topic: clean } },
        { agentName: "critic", input: {} },
      ],
      plainEnglishPlan: `I'll scan recent high-engagement posts about “${clean.slice(0, 80)}”, surface viral examples with links, draft a creator brief + next-algorithm takes, then verify citations.`,
    },
  };
}

function planImagingAnalyze(request: string, referenceAssetId: string): PlanResult {
  const clean = request.trim().slice(0, 4000);
  return {
    kind: "plan",
    plan: {
      steps: [
        {
          agentName: "imaging_analyze",
          input: { request: clean, referenceAssetId },
        },
      ],
      plainEnglishPlan:
        "I'll study your reference image and draft a generation prompt you can edit before anything is created — so you can correct what I understood first.",
    },
  };
}

function clarificationForImagingUpload(): Clarification {
  return {
    kind: "clarification",
    question:
      "To make something like a reference, upload an image first, then describe what you want.",
    options: [
      "I'll upload a reference image",
      "Summarise some text instead",
      "Research a topic instead",
      "I'm not sure — show me an example",
    ],
  };
}

/**
 * Deterministic planner. Prefer clarity over guessing — one clarifying question when unclear.
 */
export function planAgentRunDeterministic(
  request: string,
  org?: OrgAgentContext,
): PlanResult {
  ensureAgentsRegistered();
  const trimmed = request.trim();
  if (!trimmed) {
    return clarificationFor(trimmed);
  }

  if (/^create an image from a reference$/i.test(trimmed)) {
    if (org?.referenceAssetId) {
      return planImagingAnalyze(
        "Create something inspired by this reference image",
        org.referenceAssetId,
      );
    }
    return clarificationForImagingUpload();
  }

  if (/^research this topic with sources$/i.test(trimmed)) {
    return clarificationFor("please paste the topic");
  }
  if (/^social listening on (this topic|a niche)$/i.test(trimmed)) {
    return clarificationFor("please paste the topic or niche");
  }

  if (/summarise it, then repeat/i.test(trimmed) || /summary.+then.+repeat/i.test(trimmed)) {
    const text = extractQuotedOrRemainder(trimmed, /summarise it, then repeat[^.]*\.?/i) || trimmed;
    return planSummariseThenEcho(text.length > 40 ? text : trimmed);
  }
  if (/^summarise it into a short brief$/i.test(trimmed)) {
    return clarificationFor("please paste the text");
  }
  if (/^repeat it back to me$/i.test(trimmed)) {
    return clarificationFor("please paste the text");
  }

  if (org?.referenceAssetId && (looksLikeImaging(trimmed) || trimmed.length >= 8)) {
    return planImagingAnalyze(trimmed, org.referenceAssetId);
  }

  if (looksLikeImaging(trimmed)) {
    return clarificationForImagingUpload();
  }

  if (looksLikeSocialListening(trimmed)) {
    const topic =
      extractQuotedOrRemainder(
        trimmed,
        /^(please\s+)?(social listening|listen|what('?s| is) (trending|getting attention))( (on|for|about))?\s*/i,
      ) || trimmed;
    return planSocialListeningPipeline(topic);
  }

  if (looksLikeResearch(trimmed)) {
    const topic =
      extractQuotedOrRemainder(
        trimmed,
        /^(please\s+)?(research|look up|find out|investigate|compare|market scan)( (on|for|about))?\s*/i,
      ) || trimmed;
    return planResearchPipeline(topic);
  }

  if (looksLikeEcho(trimmed) && looksLikeSummarise(trimmed)) {
    const text =
      extractQuotedOrRemainder(trimmed, /\b(summaris[e]|summarize|echo|repeat)\b/gi) || trimmed;
    return planSummariseThenEcho(text);
  }

  if (looksLikeEcho(trimmed)) {
    const text =
      extractQuotedOrRemainder(
        trimmed,
        /^(please\s+)?(echo|repeat|say back|mirror)(\s+(this|the following|my (text|message)))?[:\s-]*/i,
      ) || trimmed;
    return planEcho(text);
  }

  if (looksLikeSummarise(trimmed)) {
    const text =
      extractQuotedOrRemainder(
        trimmed,
        /^(please\s+)?(summaris[e]|summarize|summary|tl;?dr|shorten|condense|brief)(\s+(this|the following|my (text|message)))?[:\s-]*/i,
      ) || trimmed;
    return planSummarise(text);
  }

  if (trimmed.split(/\s+/).length >= 40) {
    return planSummarise(trimmed);
  }

  if (isTooVague(trimmed)) {
    return clarificationFor(trimmed);
  }

  return clarificationFor(trimmed);
}

const llmPlanSchema = z.object({
  needsClarification: z.boolean(),
  question: z.string().optional(),
  options: z.array(z.string()).max(4).optional(),
  steps: z
    .array(
      z.object({
        agentName: z.enum([
          "echo",
          "summarise",
          "research",
          "social_listening",
          "analyst",
          "critic",
          "imaging_analyze",
          "imaging_generate",
        ]),
        text: z.string().optional(),
        topic: z.string().optional(),
        referenceAssetId: z.string().optional(),
        prompt: z.string().optional(),
        maxSentences: z.number().int().min(1).max(8).optional(),
      }),
    )
    .optional(),
  plainEnglishPlan: z.string().optional(),
});

/**
 * Supervisor entry: natural-language request → plan or one clarification.
 */
export async function planAgentRun(
  request: string,
  org: OrgAgentContext,
  options?: { useLlm?: boolean },
): Promise<PlanResult> {
  ensureAgentsRegistered();
  const deterministic = planAgentRunDeterministic(request, org);
  if (deterministic.kind === "plan" || !options?.useLlm) {
    return deterministic;
  }

  const agentCatalog = listAgents()
    .map((a) => `- ${a.name}: ${a.description}`)
    .join("\n");

  const result = await completeStructuredSafe(llmPlanSchema, {
    organisationId: org.organisationId,
    tier: "cheap",
    system: `You plan jobs for a business owner. Available capabilities:\n${agentCatalog}\nNever invent other capabilities. For research or social listening, prefer the full pipeline (research|social_listening → analyst → critic). For images, use imaging_analyze only when a referenceAssetId is known — never call imaging_generate until the user confirms a prompt. If unclear, ask ONE clarifying question with 2-4 short options.`,
    prompt: `Request:\n${request}\n\nOrganisation: ${org.organisationName || org.organisationId}\nReference asset id: ${org.referenceAssetId || "(none)"}`,
    skipSpendGate: false,
  });

  if (!result.ok) {
    return deterministic;
  }

  const data = result.data;
  if (data.needsClarification) {
    const optionsList = (data.options || []).filter((o) => o.trim().length > 0).slice(0, 4);
    if (data.question && optionsList.length >= 2) {
      return {
        kind: "clarification",
        question: data.question.slice(0, 400),
        options: optionsList,
      };
    }
    return deterministic;
  }

  const steps = (data.steps || [])
    .filter((s) => hasAgent(s.agentName) && s.agentName !== "imaging_generate")
    .map((s) => {
      if (s.agentName === "summarise") {
        return {
          agentName: s.agentName,
          input: { text: s.text || s.topic || "", maxSentences: s.maxSentences ?? 3 },
        };
      }
      if (s.agentName === "echo") {
        return { agentName: s.agentName, input: { text: s.text || s.topic || "" } };
      }
      if (s.agentName === "research" || s.agentName === "social_listening") {
        return { agentName: s.agentName, input: { topic: s.topic || s.text || request } };
      }
      if (s.agentName === "analyst") {
        return { agentName: s.agentName, input: { topic: s.topic || s.text || request } };
      }
      if (s.agentName === "imaging_analyze") {
        return {
          agentName: s.agentName,
          input: {
            request: s.text || s.topic || request,
            referenceAssetId: s.referenceAssetId || org.referenceAssetId || "",
          },
        };
      }
      return { agentName: s.agentName, input: {} };
    })
    .filter((s) => {
      if (s.agentName === "echo" || s.agentName === "summarise") {
        return (
          typeof (s.input as { text?: string }).text === "string" &&
          Boolean((s.input as { text: string }).text.trim())
        );
      }
      if (s.agentName === "research" || s.agentName === "social_listening") {
        return (
          typeof (s.input as { topic?: string }).topic === "string" &&
          Boolean((s.input as { topic: string }).topic.trim())
        );
      }
      if (s.agentName === "imaging_analyze") {
        return Boolean((s.input as { referenceAssetId?: string }).referenceAssetId?.trim());
      }
      return true;
    });

  if (!steps.length || !data.plainEnglishPlan?.trim()) {
    return deterministic;
  }

  const plan = agentPlanSchema.parse({
    steps,
    plainEnglishPlan: data.plainEnglishPlan.trim().slice(0, 500),
  });
  return { kind: "plan", plan };
}
