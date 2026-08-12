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
  return /\b(summaris[e]|summarize|summary|tl;?dr|shorten|condense|brief)\b/i.test(
    request,
  );
}

function isTooVague(request: string): boolean {
  const trimmed = request.trim();
  if (trimmed.length < 8) return true;
  if (AMBIGUOUS_MARKERS.some((re) => re.test(trimmed)) && !looksLikeEcho(trimmed) && !looksLikeSummarise(trimmed)) {
    return true;
  }
  // Bare text with no clear intent and no "summarise/echo" verb → clarify
  if (!looksLikeEcho(trimmed) && !looksLikeSummarise(trimmed)) {
    // Long enough body might imply "summarise this"
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
          "Summarise it, then repeat the original",
        ]
      : [
          "Summarise some text I'll paste next",
          "Repeat text back to me",
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

/**
 * Deterministic planner for the Echo + Summarise proof agents.
 * Prefer clarity over guessing — one clarifying question when intent is unclear.
 */
export function planAgentRunDeterministic(
  request: string,
  _org?: OrgAgentContext,
): PlanResult {
  ensureAgentsRegistered();
  const trimmed = request.trim();
  if (!trimmed) {
    return clarificationFor(trimmed);
  }

  // Clarification answers (tapped options) map to plans.
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

  // Long body with no verb → treat as summarise (sensible default).
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
        agentName: z.enum(["echo", "summarise"]),
        text: z.string(),
        maxSentences: z.number().int().min(1).max(8).optional(),
      }),
    )
    .optional(),
  plainEnglishPlan: z.string().optional(),
});

/**
 * Supervisor entry: natural-language request → plan or one clarification.
 * Uses deterministic rules first; optional LLM assist when `useLlm` is true.
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

  // Ambiguous + LLM assist: still only Echo/Summarise, still one question max.
  const agentCatalog = listAgents()
    .map((a) => `- ${a.name}: ${a.description}`)
    .join("\n");

  const result = await completeStructuredSafe(llmPlanSchema, {
    organisationId: org.organisationId,
    tier: "cheap",
    system: `You plan simple text jobs for a business owner. Available capabilities:\n${agentCatalog}\nNever invent other capabilities. If unclear, ask ONE clarifying question with 2-4 short options.`,
    prompt: `Request:\n${request}\n\nOrganisation: ${org.organisationName || org.organisationId}`,
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
    .filter((s) => hasAgent(s.agentName) && s.text.trim().length > 0)
    .map((s) => ({
      agentName: s.agentName,
      input:
        s.agentName === "summarise"
          ? { text: s.text, maxSentences: s.maxSentences ?? 3 }
          : { text: s.text },
    }));

  if (!steps.length || !data.plainEnglishPlan?.trim()) {
    return deterministic;
  }

  const plan = agentPlanSchema.parse({
    steps,
    plainEnglishPlan: data.plainEnglishPlan.trim().slice(0, 500),
  });
  return { kind: "plan", plan };
}
