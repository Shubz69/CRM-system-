import { z } from "zod";

export const objectionSchema = z.object({
  category: z.string().min(1),
  text: z.string().min(1),
});

/**
 * Legacy flat analysis schema used by the inbound rule engine.
 * Kept for backward compatibility with mock provider + existing pipeline.
 */
export const aiAnalysisSchema = z.object({
  intent: z.string().min(1),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
  conversation_summary: z.string().min(1),
  qualification_score: z.number().min(0).max(100),
  qualification_status: z.enum([
    "unknown",
    "qualifying",
    "qualified",
    "disqualified",
  ]),
  qualification_reasons: z.array(z.string()).default([]),
  answers_collected: z.record(z.string()).default({}),
  missing_qualification_fields: z.array(z.string()).default([]),
  questions_detected: z.array(z.string()).default([]),
  objections_detected: z.array(objectionSchema).default([]),
  buying_signals: z.array(z.string()).default([]),
  recommended_next_action: z.enum([
    "ask_qualification_question",
    "answer_question",
    "handle_objection",
    "send_booking_link",
    "follow_up_later",
    "handover_to_human",
    "disqualify",
    "nurture",
  ]),
  should_handover: z.boolean(),
  handover_reason: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reply: z.string().min(1),
  /** Optional richer CRM memory extracted by Claude */
  crm_updates: z
    .object({
      name: z.string().nullable().optional(),
      company: z.string().nullable().optional(),
      role: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
      need: z.string().nullable().optional(),
      budget: z.string().nullable().optional(),
      timeline: z.string().nullable().optional(),
      decisionAuthority: z.string().nullable().optional(),
      businessSize: z.string().nullable().optional(),
      serviceInterest: z.array(z.string()).optional(),
      goals: z.string().nullable().optional(),
      painPoints: z.array(z.string()).optional(),
    })
    .optional(),
  knowledge_gap: z
    .object({
      detected: z.boolean(),
      question: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
    })
    .optional(),
  pipeline_recommendation: z
    .object({
      stage: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
});

export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;

/**
 * Canonical Claude structured decision (preferred).
 * Normalized to AiAnalysis for the rule engine.
 */
export const claudeDecisionSchema = z.object({
  reply: z.string().min(1),
  intent: z.object({
    primary: z.string().min(1),
    confidence: z.number().min(0).max(1).default(0.7),
  }),
  sentiment: z.object({
    label: z.enum(["positive", "neutral", "negative", "mixed"]),
    confidence: z.number().min(0).max(1).default(0.7),
  }),
  crmUpdates: z
    .object({
      name: z.string().nullable().optional(),
      company: z.string().nullable().optional(),
      role: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
      need: z.string().nullable().optional(),
      budget: z.string().nullable().optional(),
      timeline: z.string().nullable().optional(),
      decisionAuthority: z.string().nullable().optional(),
      businessSize: z.string().nullable().optional(),
      serviceInterest: z.array(z.string()).optional(),
      goals: z.string().nullable().optional(),
      painPoints: z.array(z.string()).optional(),
    })
    .default({}),
  questions: z
    .array(
      z.object({
        question: z.string(),
        canonicalQuestion: z.string().optional(),
        category: z.string().optional(),
        answered: z.boolean().optional(),
      }),
    )
    .default([]),
  objections: z
    .array(
      z.object({
        objection: z.string(),
        canonicalObjection: z.string().optional(),
        category: z.string().default("other"),
        strength: z.number().min(0).max(1).optional(),
        resolved: z.boolean().optional(),
      }),
    )
    .default([]),
  qualification: z.object({
    status: z.enum(["unknown", "qualifying", "qualified", "disqualified"]),
    fieldsUpdated: z.record(z.string()).default({}),
    missingFields: z.array(z.string()).default([]),
    reason: z.string().nullable().optional(),
    score: z.number().min(0).max(100).optional(),
  }),
  leadScoreRecommendation: z
    .object({
      change: z.number().default(0),
      reason: z.string().default(""),
    })
    .optional(),
  pipelineRecommendation: z
    .object({
      stage: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  nextBestAction: z.object({
    action: z.enum([
      "reply",
      "ask_question",
      "follow_up",
      "booking",
      "wait",
      "handoff",
      "disqualify",
      "close",
      "ask_qualification_question",
      "answer_question",
      "handle_objection",
      "send_booking_link",
      "follow_up_later",
      "handover_to_human",
      "nurture",
    ]),
    reason: z.string().default(""),
  }),
  booking: z
    .object({
      sendLink: z.boolean().default(false),
      reason: z.string().nullable().optional(),
    })
    .optional(),
  followUp: z
    .object({
      required: z.boolean().default(false),
      delayMinutes: z.number().nullable().optional(),
      goal: z.string().nullable().optional(),
    })
    .optional(),
  handoff: z
    .object({
      required: z.boolean().default(false),
      reason: z.string().nullable().optional(),
      urgency: z.enum(["normal", "high"]).default("normal"),
    })
    .optional(),
  knowledgeGap: z
    .object({
      detected: z.boolean().default(false),
      question: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
    })
    .optional(),
  conversation_summary: z.string().optional(),
  buying_signals: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
});

export type ClaudeDecision = z.infer<typeof claudeDecisionSchema>;

function mapNextAction(
  action: string,
  booking?: { sendLink?: boolean },
  handoff?: { required?: boolean },
): AiAnalysis["recommended_next_action"] {
  if (handoff?.required) return "handover_to_human";
  if (booking?.sendLink || action === "booking" || action === "send_booking_link") {
    return "send_booking_link";
  }
  switch (action) {
    case "ask_question":
    case "ask_qualification_question":
      return "ask_qualification_question";
    case "answer_question":
      return "answer_question";
    case "handle_objection":
      return "handle_objection";
    case "follow_up":
    case "follow_up_later":
    case "wait":
      return "follow_up_later";
    case "handoff":
    case "handover_to_human":
      return "handover_to_human";
    case "disqualify":
    case "close":
      return "disqualify";
    case "nurture":
      return "nurture";
    case "reply":
    default:
      return "answer_question";
  }
}

export function normalizeClaudeDecision(decision: ClaudeDecision): AiAnalysis {
  const score =
    decision.qualification.score ??
    (decision.qualification.status === "qualified"
      ? 75
      : decision.qualification.status === "disqualified"
        ? 15
        : 50);

  return {
    intent: decision.intent.primary,
    sentiment: decision.sentiment.label,
    conversation_summary:
      decision.conversation_summary ||
      `Intent: ${decision.intent.primary}. Next: ${decision.nextBestAction.action}.`,
    qualification_score: score,
    qualification_status: decision.qualification.status,
    qualification_reasons: decision.qualification.reason
      ? [decision.qualification.reason]
      : [],
    answers_collected: decision.qualification.fieldsUpdated || {},
    missing_qualification_fields: decision.qualification.missingFields || [],
    questions_detected: decision.questions.map((q) => q.canonicalQuestion || q.question),
    objections_detected: decision.objections.map((o) => ({
      category: o.category || "other",
      text: o.canonicalObjection || o.objection,
    })),
    buying_signals: decision.buying_signals || [],
    recommended_next_action: mapNextAction(
      decision.nextBestAction.action,
      decision.booking,
      decision.handoff,
    ),
    should_handover: Boolean(decision.handoff?.required) || decision.nextBestAction.action === "handoff",
    handover_reason: decision.handoff?.reason ?? null,
    confidence: decision.confidence,
    reply: decision.reply,
    crm_updates: decision.crmUpdates,
    knowledge_gap: decision.knowledgeGap
      ? {
          detected: decision.knowledgeGap.detected,
          question: decision.knowledgeGap.question,
          reason: decision.knowledgeGap.reason,
        }
      : undefined,
    pipeline_recommendation: decision.pipelineRecommendation,
  };
}

export function parseAiAnalysis(input: unknown): {
  success: true;
  data: AiAnalysis;
  format: "legacy" | "claude_decision";
} | {
  success: false;
  error: z.ZodError;
} {
  const rich = claudeDecisionSchema.safeParse(input);
  if (rich.success) {
    return {
      success: true,
      data: normalizeClaudeDecision(rich.data),
      format: "claude_decision",
    };
  }

  const legacy = aiAnalysisSchema.safeParse(input);
  if (legacy.success) {
    return { success: true, data: legacy.data, format: "legacy" };
  }

  // Prefer richer error when input looks nested
  if (input && typeof input === "object" && "nextBestAction" in (input as object)) {
    return { success: false, error: rich.error };
  }
  return { success: false, error: legacy.error };
}

export const CLAUDE_DECISION_JSON_INSTRUCTIONS = `Return ONLY valid JSON matching this schema (preferred):
{
  "reply": "string",
  "intent": { "primary": "pricing|qualification|booking|objection|support|complaint|information|human_request|spam|other", "confidence": 0.0 },
  "sentiment": { "label": "positive|neutral|negative|mixed", "confidence": 0.0 },
  "crmUpdates": { "name": null, "company": null, "role": null, "email": null, "phone": null, "location": null, "need": null, "budget": null, "timeline": null, "decisionAuthority": null, "businessSize": null, "serviceInterest": [], "goals": null, "painPoints": [] },
  "questions": [{ "question": "string", "canonicalQuestion": "string", "category": "string", "answered": false }],
  "objections": [{ "objection": "string", "canonicalObjection": "string", "category": "price|trust|timing|authority|need|implementation|competitor|other", "strength": 0.0, "resolved": false }],
  "qualification": { "status": "unknown|qualifying|qualified|disqualified", "fieldsUpdated": {}, "missingFields": [], "reason": null, "score": 0 },
  "leadScoreRecommendation": { "change": 0, "reason": "string" },
  "pipelineRecommendation": { "stage": "string", "reason": "string" },
  "nextBestAction": { "action": "reply|ask_question|follow_up|booking|wait|handoff|disqualify|close|ask_qualification_question|answer_question|handle_objection|send_booking_link|follow_up_later|handover_to_human|nurture", "reason": "string" },
  "booking": { "sendLink": false, "reason": null },
  "followUp": { "required": false, "delayMinutes": null, "goal": null },
  "handoff": { "required": false, "reason": null, "urgency": "normal|high" },
  "knowledgeGap": { "detected": false, "question": null, "reason": null },
  "conversation_summary": "string",
  "buying_signals": [],
  "confidence": 0.0
}

Rules:
- Never invent prices, services, policies, discounts, guarantees, opening times, availability, terms, or refunds not present in knowledge.
- Do not re-ask facts already present in CRM memory.
- If knowledge is insufficient for a factual answer, set knowledgeGap.detected=true and ask a clarifying question or handoff.
- Claude recommends; the application rule engine decides what executes.`;
