import type { AiAnalysis } from "@/schemas/ai";

export type ScoreComponent = {
  factor: string;
  points: number;
  reason: string;
};

export type ScoringRules = {
  weights?: {
    businessFit?: number;
    need?: number;
    urgency?: number;
    budget?: number;
    authority?: number;
    engagement?: number;
    sentiment?: number;
    buyingSignals?: number;
  };
  disqualifyScore?: number;
};

const DEFAULT_WEIGHTS = {
  businessFit: 20,
  need: 15,
  urgency: 10,
  budget: 15,
  authority: 10,
  engagement: 10,
  sentiment: 10,
  buyingSignals: 10,
};

/**
 * Configurable deterministic scoring. Rules come from AgentConfiguration.scoringRules.
 * The AI may suggest a score, but persisted scoring uses these editable rules.
 */
export function calculateLeadScore(input: {
  analysis: AiAnalysis;
  rules?: ScoringRules;
  messageCount?: number;
}): { totalScore: number; components: ScoreComponent[]; explanation: string } {
  const weights = { ...DEFAULT_WEIGHTS, ...(input.rules?.weights ?? {}) };
  const components: ScoreComponent[] = [];
  const answers = input.analysis.answers_collected;
  const lowerSummary = input.analysis.conversation_summary.toLowerCase();

  const hasBusiness =
    Boolean(answers.business_type) || /business|coach|agency|brand|company/.test(lowerSummary);
  components.push({
    factor: "businessFit",
    points: hasBusiness ? weights.businessFit : 0,
    reason: hasBusiness ? "Business use case detected" : "No clear business fit yet",
  });

  const hasNeed =
    input.analysis.questions_detected.length > 0 ||
    /need|help|struggling|enquir|dm/.test(lowerSummary);
  components.push({
    factor: "need",
    points: hasNeed ? weights.need : Math.round(weights.need * 0.3),
    reason: hasNeed ? "Need expressed through questions or summary" : "Need still unclear",
  });

  const urgent = /asap|urgent|this week|now|immediately/.test(lowerSummary);
  components.push({
    factor: "urgency",
    points: urgent ? weights.urgency : Math.round(weights.urgency * 0.2),
    reason: urgent ? "Urgency language detected" : "No strong urgency",
  });

  const budgetKnown = Boolean(answers.budget) || /budget|afford|price/.test(lowerSummary);
  components.push({
    factor: "budget",
    points: budgetKnown ? weights.budget : 0,
    reason: budgetKnown ? "Budget/pricing discussion present" : "Budget unknown",
  });

  const authority = Boolean(answers.authority) || /founder|owner|i run|decision/.test(lowerSummary);
  components.push({
    factor: "authority",
    points: authority ? weights.authority : Math.round(weights.authority * 0.4),
    reason: authority ? "Authority signals present" : "Authority unclear",
  });

  const engagementBoost = Math.min(
    weights.engagement,
    Math.round(((input.messageCount ?? 1) / 5) * weights.engagement),
  );
  components.push({
    factor: "engagement",
    points: engagementBoost,
    reason: `Based on ~${input.messageCount ?? 1} messages`,
  });

  const sentimentPoints =
    input.analysis.sentiment === "positive"
      ? weights.sentiment
      : input.analysis.sentiment === "negative"
        ? 0
        : Math.round(weights.sentiment * 0.5);
  components.push({
    factor: "sentiment",
    points: sentimentPoints,
    reason: `Sentiment: ${input.analysis.sentiment}`,
  });

  const buyingPoints = Math.min(
    weights.buyingSignals,
    input.analysis.buying_signals.length * Math.round(weights.buyingSignals / 2),
  );
  components.push({
    factor: "buyingSignals",
    points: buyingPoints,
    reason:
      input.analysis.buying_signals.length > 0
        ? `Signals: ${input.analysis.buying_signals.join("; ")}`
        : "No buying signals",
  });

  if (input.analysis.qualification_status === "disqualified") {
    components.push({
      factor: "disqualification",
      points: -(input.rules?.disqualifyScore ?? 50),
      reason: "Disqualification criteria met",
    });
  }

  const totalScore = Math.max(
    0,
    Math.min(
      100,
      components.reduce((sum, c) => sum + c.points, 0),
    ),
  );

  const explanation = components
    .map((c) => `${c.factor}: ${c.points} (${c.reason})`)
    .join(" | ");

  return { totalScore, components, explanation };
}
