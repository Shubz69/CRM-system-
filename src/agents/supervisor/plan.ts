import { z } from "zod";
import { ensureAgentsRegistered, hasAgent, listAgents } from "@/agents";
import { completeStructuredSafe } from "@/adapters/ai/structured";
import type { Clarification, OrgAgentContext, PlanResult } from "@/agents/supervisor/types";
import { agentPlanSchema } from "@/agents/supervisor/types";
import {
  detectAnswerModeFromLanguage,
  formatClarification,
} from "@/services/answer-modes";
import {
  sanitizeResearchTopic,
  stripClarificationMetadata,
} from "@/lib/agent-request-sanitize";

const AMBIGUOUS_MARKERS = [
  /what (can|should) (you|i) (do|help)(?!\s+(today|now|next|with my|from))/i,
  /^help me$/i,
  /not sure what you mean/i,
  /\b(something|anything)\b.*\b(idk|not sure)\b/i,
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

export function looksLikeOperatorBrief(request: string): boolean {
  const t = request.toLowerCase();
  // Require day/operator framing — not bare "what should I do with this?"
  if (/\bwhat should i do with (this|that|it)\b/.test(t)) return false;
  // Concrete CRM facts stay on specialized CRM intents, not the full operator brief.
  if (
    /\b(which|what) deals?\b.*\b(stuck|stalled)\b|\bdeals?\b.*\b(stuck|stalled)\b/.test(t) &&
    !/\b(today|prioritis|operator|automate|ignore)\b/.test(t)
  ) {
    return false;
  }
  if (/\bgoals?\b.*\bat risk\b|\bat risk\b.*\bgoals?\b/.test(t) && !/\b(today|prioritis|operator)\b/.test(t)) {
    return false;
  }
  // Reply/follow-up fact questions → follow_ups intent, not full brief (Quick path).
  // ACTION/EXECUTIVE forces operator_brief later via preferOperatorBriefForMode.
  if (
    /\b(who needs (a )?reply|customers? need(s)? follow|needing reply|needing (a )?human|needs? human|waiting on me|inbox.{0,40}(waiting|human|reply))\b/.test(
      t,
    ) &&
    !/\b(today|prioritis|operator brief|what should i do)\b/.test(t)
  ) {
    return false;
  }
  // Content approval inventory → content intent.
  if (
    /\b(content|drafts?).*\b(awaiting|waiting|approval|in review)\b/.test(t) &&
    !/\b(should i create|what content should)\b/.test(t)
  ) {
    return false;
  }
  return (
    /\bwhat should i (do today|focus on|prioritis[eo]|work on today)\b/.test(t) ||
    (/\bwhat should i do\b/.test(t) && /\b(today|daily|now|next|priority|operator)\b/.test(t)) ||
    /\b(daily|today'?s?)\s+(brief|priorit|agenda|plan|operator)\b/.test(t) ||
    /\bwhich (lead|opportunit|kpi)\b/.test(t) ||
    /\bwhat opportunit/.test(t) ||
    /\b(detected )?opportunit(y|ies)\b.*\b(review|attention|matter|focus)\b/.test(t) ||
    /\bwhat (should|can) i (automate|ignore|create|deprioritis[e]?|improve)\b/.test(t) ||
    /\bwhat content should (i )?create\b/.test(t) ||
    /\b(worth automating|should i automate|repetitive process)\b/.test(t) ||
    /\b(deprioritis[e]?|what can wait|what should i ignore|safely deprioritis[e]?)\b/.test(t) ||
    /\bwhat changed recently\b/.test(t) ||
    /\bwhere are we losing momentum\b/.test(t) ||
    /\bbiggest (sales )?risk\b/.test(t) ||
    /\bare we neglecting\b/.test(t) ||
    /\bblocking revenue\b|\bwasting time\b|\bhighest-value actions\b/.test(t) ||
    /\boperator brief\b/.test(t) ||
    /\bchief of staff\b/.test(t) ||
    /\bprioritis[e].*\b(today|crm|from)\b|\bfrom crm\b/.test(t) ||
    /\b(what'?s urgent|any fires|top risk|status check|crm pulse|are we healthy|what matters (this )?(morning|today|now))\b/.test(
      t,
    ) ||
    /\b(who should i talk to|who is waiting on me|anything overdue|where are we behind|blocking progress)\b/.test(t) ||
    /\b(needs? attention|what needs me|pipeline and inbox)\b/.test(t)
  );
}

export function looksLikeCrmInternal(request: string): boolean {
  const t = request.toLowerCase();
  if (looksLikeOperatorBrief(t)) return true;
  if (
    /\b(summaris[e]|summarize|summary)\b/.test(t) &&
    /\b(pipeline|deals?|crm|inbox|leads?|follow[- ]?ups?|goals? at risk|awaiting approval|content)\b/.test(t)
  ) {
    return true;
  }
  return (
    /\b(my pipeline|our pipeline|the pipeline|pipeline summary|pipeline looking|open deals?)\b/.test(t) ||
    /\bhow is (my |our |the )?pipeline\b/.test(t) ||
    /\bstalled\b.*\bdeals?\b|\bdeals?\b.*\bstalled\b|\bwhich deals?\b/.test(t) ||
    /\bdeals?\b.{0,40}\b(quiet|went quiet|ages|stale)\b|\b(quiet|stale)\b.{0,40}\bdeals?\b/.test(t) ||
    /\b(conversations? needing (a )?human|needs? (my )?attention|follow[- ]?ups?|customers? need)\b/.test(t) ||
    /\bhow many\s+conversations\b/.test(t) ||
    /\b(goals?\b.{0,40}\bat risk|at risk\b.{0,40}\bgoals?|goals? marked at risk|kpi|goals? need|which goal)\b/.test(
      t,
    ) ||
    /\bdo we have goals\b/.test(t) ||
    /\b(content\s+(is\s+)?(awaiting|waiting for) approval|awaiting approval|waiting for approval|content in review)\b/.test(
      t,
    ) ||
    /\b(in review|pending).{0,24}\bcontent\b|\bcontent\b.{0,24}\b(in review|approval|approvals?)\b/.test(t) ||
    /\bapprovals?\b.{0,30}\b(pending|content)\b/.test(t) ||
    /\bany content\b.*\b(approval|review)\b/.test(t) ||
    /\b(my|our)\s+(\w+\s+){0,3}(contacts?|deals?|leads?|crm|compan(?:y|ies)|content|inbox)\b/.test(t) ||
    /\bhow many\s+(contacts?|deals?|leads?|compan(?:y|ies)|conversations)\b/.test(t) ||
    /\b(contact|contacts|deal|deals)\s+(count|total|inventory|size)\b/.test(t) ||
    /\b(contacts? total|total contacts?|inventory size)\b/.test(t) ||
    /\b(list|name|show|give me|newest)\b.*\b(contacts?|compan(?:y|ies)|deals?)\b/.test(t) ||
    /\bnewest contacts?\b/.test(t) ||
    /\bare any goals\b/.test(t) ||
    /\binternal (crm|data|workspace|knowledge)\b/.test(t) ||
    /\b(this|my|our)\s+workspace\b/.test(t) ||
    /\bworkspace[- ]only\b/.test(t) ||
    /\bbusiness (profile|context)\b/.test(t) ||
    /\bwhat (do|does) (we|our(?:\s+(?:business|company))?|the business|the company) sell\b/.test(t) ||
    /\bwhat industry\b/.test(t) ||
    /\bwho (is|are) (our|my) (customer|audience)\b/.test(t) ||
    /\bfrom (my|our|this)\s+(crm|workspace|business)\b/.test(t) ||
    /\bwho needs (a )?reply\b/.test(t) ||
    /\bdeals?\b.*\bstuck\b|\bstuck\b.*\bdeals?\b/.test(t) ||
    /\bpipeline health\b|\bhealth of (my|our|the) pipeline\b/.test(t) ||
    /\bopportunit(y|ies)\b/.test(t) ||
    /\b(crm pulse|status check|inbox snapshot|what needs me|what'?s urgent|any fires|top risk)\b/.test(t) ||
    /\b(how many open|don'?t invent deals|crm contacts?)\b/.test(t)
  );
}

function isPureDeterministicCrmFact(request: string): boolean {
  const t = request.toLowerCase();
  // Only inventory/count questions stay on specialized intents under ACTION/EXECUTIVE.
  // Judgement / "who/which/what needs…" questions use the operator brief in those modes.
  return (
    /\bhow many\b/.test(t) ||
    /\b(contact|contacts|deal|deals)\s+(count|total|inventory|size)\b/.test(t) ||
    /\b(contacts? total|total contacts?)\b/.test(t) ||
    /\b(list|name|show|give me|newest)\b.*\b(contacts?|compan(?:y|ies)|deals?)\b/.test(t) ||
    /\bnewest contacts?\b/.test(t) ||
    /\bname one company\b/.test(t) ||
    /\bcontacts? count\b/.test(t) ||
    (/\b(content).*\b(awaiting|waiting|approval|in review)\b/.test(t) &&
      !/\b(should i create|what content should)\b/.test(t) &&
      !/\b(today|prioritis|operator)\b/.test(t)) ||
    (/\bgoals?\b.{0,40}\bat risk\b/.test(t) && !/\b(today|prioritis|operator|attention|kpi needs)\b/.test(t))
  );
}

function crmDeskIntentFromRequest(
  request: string,
  opts?: { preferOperatorBrief?: boolean },
):
  | "pipeline_summary"
  | "follow_ups"
  | "goals_at_risk"
  | "conversations_needing_human"
  | "content_awaiting_approval"
  | "operator_brief"
  | "business_context"
  | "desk_overview" {
  const t = request.toLowerCase();
  if (opts?.preferOperatorBrief && !isPureDeterministicCrmFact(t)) {
    return "operator_brief";
  }
  if (looksLikeOperatorBrief(t)) return "operator_brief";
  if (
    /\bbusiness (profile|context)\b/.test(t) ||
    /\bwhat (do|does) (we|our(?:\s+(?:business|company))?|the business|the company) sell\b/.test(t) ||
    /\bwhat industry\b/.test(t) ||
    /\bwho (is|are) (our|my) (customer|audience)\b/.test(t)
  ) {
    return "business_context";
  }
  if (/\bgoals?\b/.test(t) || /\bkpi\b/.test(t)) return "goals_at_risk";
  if (
    /\bcontent\b/.test(t) &&
    /\b(awaiting|waiting|approval|review|create|should i)\b/.test(t)
  ) {
    return "content_awaiting_approval";
  }
  if (
    /\bneeding (a )?human|handoff|needs? human\b/.test(t) ||
    /\bhow many\s+conversations\b/.test(t)
  ) {
    return "conversations_needing_human";
  }
  if (/\bfollow[- ]?ups?|needing reply|needs? reply|who needs (a )?reply|customers? need(s)? follow\b/.test(t)) {
    return "follow_ups";
  }
  if (
    /\bpipeline|stalled|stuck|open deals?|which deal|deals? look|pipeline health|pipeline looking\b/.test(t)
  ) {
    return "pipeline_summary";
  }
  if (/\bopportunit/.test(t)) return "operator_brief";
  return "desk_overview";
}

function planCrmDesk(request: string, opts?: { preferOperatorBrief?: boolean }): PlanResult {
  const intent = crmDeskIntentFromRequest(request, opts);
  return {
    kind: "plan",
    plan: {
      steps: [{ agentName: "crm_desk", input: { intent, request: request.slice(0, 2000) } }],
      plainEnglishPlan:
        intent === "operator_brief"
          ? "I'll read this workspace's CRM, inbox, goals, content, and opportunities and give you a prioritised operator brief — no web research."
          : intent === "pipeline_summary"
            ? "I'll read your open deals in this workspace and flag anything stalled — no web research."
            : intent === "business_context"
              ? "I'll read your Business Profile / business context for this workspace — no web research."
              : intent === "goals_at_risk"
                ? "I'll check goals and KPIs marked at risk in this workspace — no web research."
                : intent === "follow_ups" || intent === "conversations_needing_human"
                  ? "I'll check Inbox conversations that need a reply or human handoff — no web research."
                  : intent === "content_awaiting_approval"
                    ? "I'll list content waiting for approval in this workspace — no web research."
                    : "I'll read this workspace's CRM data (deals, inbox, goals, content) and summarise what needs attention.",
    },
  };
}

function looksLikeSocialListening(request: string): boolean {
  return /\b(social listening|what('?s| is) (trending|getting attention)|high[- ]engagement|hooks and formats|content themes|audience complaints)\b/i.test(
    request,
  );
}

function looksLikeResearch(request: string): boolean {
  if (looksLikeSocialListening(request)) return false;
  if (looksLikeImaging(request)) return false;
  // Negated research / CRM-only instructions must not force the research pipeline.
  if (/\b(not|without|no)\s+(web\s+)?research\b/i.test(request) || /\binternal only\b/i.test(request)) {
    if (looksLikeCrmInternal(request) || /\b(crm|contacts?|deals?|pipeline|inbox|workspace)\b/i.test(request)) {
      return false;
    }
  }
  if (looksLikeCrmInternal(request) && !/\b(research|look up|investigate|compare|ico|gdpr|authority)\b/i.test(request)) {
    return false;
  }
  return (
    /\b(research|look up|find (out|sources|articles)|investigate|compare|competitive analysis|market scan)\b/i.test(
      request,
    ) ||
    /\bwhat does the (ico|fca|asa|ofcom|hmrc|gov\.uk)\b/i.test(request) ||
    /\b(gdpr|ico guidance|regulatory|legislation)\b/i.test(request) ||
    /\bcompare\b.+\band\b/i.test(request)
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
  if (looksLikeCrmInternal(trimmed) || looksLikeOperatorBrief(trimmed)) return false;
  if (looksLikeResearch(trimmed) || looksLikeEcho(trimmed) || looksLikeSummarise(trimmed)) {
    return false;
  }
  if (looksLikeSocialListening(trimmed) || looksLikeImaging(trimmed)) return false;
  // Ambiguous markers without a concrete object → clarify.
  if (AMBIGUOUS_MARKERS.some((re) => re.test(trimmed))) {
    return true;
  }
  // Short non-CRM prompts without a clear verb stay vague; longer ones can research.
  if (trimmed.split(/\s+/).length >= 12) return false;
  return true;
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

/** Classify research intent so business-factual questions do not get a viral/social plan. */
export type ResearchIntentKind =
  | "business_factual"
  | "market"
  | "social_content"
  | "crm_internal"
  | "prospecting"
  | "summarisation"
  | "strategy"
  | "content_gen";

export function classifyResearchIntent(topic: string): ResearchIntentKind {
  const t = topic.toLowerCase();
  // CRM/pipeline internal before summarisation — "Summarise my pipeline" must not echo the prompt.
  if (looksLikeCrmInternal(topic)) return "crm_internal";
  if (/\b(summaris|summariz|tl;?dr|condense|shorten)\b/.test(t)) return "summarisation";
  if (/\b(prospect|find (leads|buyers|customers)|outreach list|icp)\b/.test(t)) return "prospecting";
  if (/\b(pipeline|inbox)\b/.test(t) || /\b(my|our)\s+(contacts|deals|leads|crm)\b/.test(t) || /\binternal\b/.test(t)) {
    return "crm_internal";
  }
  if (
    /\b(viral|trending|hooks?|reels?|shorts?|algorithm|social listening|what('?s| is) getting attention|content themes)\b/.test(
      t,
    )
  ) {
    return "social_content";
  }
  if (/\b(write|draft|create|generate)\b.+\b(post|content|caption|script)\b/.test(t)) {
    return "content_gen";
  }
  if (/\b(strateg(y|ic)|roadmap|go[- ]to[- ]market|gtm|positioning)\b/.test(t)) return "strategy";
  // Prefer explicit factual question shapes before broad "market" keywords (adoption/pricing).
  if (
    /\b(what is|how (many|much)|statistics?|data on|rate of|adoption of|facts? about)\b/.test(t) ||
    (/\b(sme|uk)\b/.test(t) && /\b(adoption|statistic|rate)\b/.test(t) && !/\b(competitor|tam|sam)\b/.test(t))
  ) {
    return "business_factual";
  }
  if (/\b(market|tam|sam|competitors?|competitive|industry|adoption|pricing|benchmark)\b/.test(t)) {
    return "market";
  }
  return "business_factual";
}

function planResearchPipeline(
  topic: string,
  options?: { answerMode?: string | null },
): PlanResult {
  const clean = sanitizeResearchTopic(topic) || stripClarificationMetadata(topic).slice(0, 2000);
  const intent = classifyResearchIntent(clean);
  const socialish = intent === "social_content" || intent === "content_gen";
  const quick = options?.answerMode === "QUICK";
  // Quick must not silently run the full research→analyst→critic stack.
  if (quick) {
    return {
      kind: "plan",
      plan: {
        steps: [
          {
            agentName: "research",
            input: { topic: clean, nicheHint: intent, maxSources: 6, depth: "FAST" },
          },
        ],
        plainEnglishPlan: `I'll do a fast sourced scan of “${clean.slice(0, 80)}” and give you a short answer. For a full research brief, use Deep / Research mode.`,
      },
    };
  }
  return {
    kind: "plan",
    plan: {
      steps: [
        { agentName: "research", input: { topic: clean, nicheHint: intent } },
        { agentName: "analyst", input: { topic: clean } },
        { agentName: "critic", input: {} },
      ],
      plainEnglishPlan: socialish
        ? `I'll research recent high-signal posts and videos about “${clean.slice(0, 80)}”, pull example links, write a short take + full brief, then note what formats appear to be working.`
        : `I'll research sourced facts and evidence about “${clean.slice(0, 80)}”, pull reviewable source links, write a grounded answer, then flag gaps or contradictions.`,
    },
  };
}

function planSocialListeningPipeline(topic: string): PlanResult {
  const clean = sanitizeResearchTopic(topic) || stripClarificationMetadata(topic).slice(0, 2000);
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

  const modeEarly = org?.answerMode ?? detectAnswerModeFromLanguage(trimmed);
  const preferOperatorBrief =
    modeEarly === "ACTION" || modeEarly === "EXECUTIVE";

  // Internal CRM / pipeline — before summarise/research so "Summarise my pipeline" uses deals.
  if (looksLikeCrmInternal(trimmed) || looksLikeOperatorBrief(trimmed)) {
    return planCrmDesk(trimmed, { preferOperatorBrief });
  }

  if (looksLikeSocialListening(trimmed)) {
    if (!org?.answerMode && !detectAnswerModeFromLanguage(trimmed)) {
      return formatClarification();
    }
    const topic =
      extractQuotedOrRemainder(
        trimmed,
        /^(please\s+)?(social listening|listen|what('?s| is) (trending|getting attention))( (on|for|about))?\s*/i,
      ) || trimmed;
    return planSocialListeningPipeline(topic);
  }

  if (looksLikeResearch(trimmed)) {
    if (!org?.answerMode && !detectAnswerModeFromLanguage(trimmed)) {
      return formatClarification();
    }
    const topic =
      extractQuotedOrRemainder(
        trimmed,
        /^(please\s+)?(research|look up|find out|investigate|compare|market scan)( (on|for|about))?\s*/i,
      ) || trimmed;
    return planResearchPipeline(topic, {
      answerMode: org?.answerMode ?? detectAnswerModeFromLanguage(trimmed),
    });
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

  // When the user already picked Quick / Action / Executive, avoid vague stalls —
  // prefer workspace CRM/operator answers over clarification for short business asks.
  const mode = modeEarly;
  if (mode === "QUICK" || mode === "ACTION" || mode === "EXECUTIVE") {
    if (looksLikeCrmInternal(trimmed) || looksLikeOperatorBrief(trimmed)) {
      return planCrmDesk(trimmed, { preferOperatorBrief });
    }
    // Short ambiguous-but-normal business questions → answer from CRM state, don't clarify.
    if (
      trimmed.split(/\s+/).length <= 12 &&
      /\b(pipeline|inbox|crm|deal|lead|customer|focus|urgent|risk|overdue|healthy|attention|today|week|status check|fires|pulse|snapshot|blocking progress|waiting on me)\b/i.test(
        trimmed,
      )
    ) {
      return planCrmDesk(trimmed, {
        preferOperatorBrief: preferOperatorBrief || mode === "QUICK",
      });
    }
    if (mode === "QUICK" && trimmed.split(/\s+/).length >= 8 && !isTooVague(trimmed)) {
      return planResearchPipeline(trimmed, { answerMode: mode });
    }
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
          "crm_desk",
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
      if (s.agentName === "crm_desk") {
        return {
          agentName: s.agentName,
          input: { intent: "desk_overview", request: s.text || s.topic || request },
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
