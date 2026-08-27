export type BusinessStateFacts = {
  inactivityDays?: number;
  responseLatencyHours?: number;
  engagementDelta?: number;
  engagementRate?: number;
  saturationRate?: number;
  touchCount?: number;
  positiveSignals?: number;
  negativeSignals?: number;
  fitScore?: number;
  relationshipStrength?: number;
  daysToClose?: number;
  stage?: string;
};

export type StateCalculation = {
  value: string;
  numericValue?: number;
  reasonCode: string;
};

export type StateCalculator = (facts: BusinessStateFacts) => StateCalculation;

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));

const unknown = (reasonCode: string): StateCalculation => ({
  value: "UNKNOWN",
  reasonCode,
});

export const calculateDealUrgency: StateCalculator = (facts) => {
  if (facts.inactivityDays == null && facts.daysToClose == null) {
    return unknown("insufficient_urgency_facts");
  }
  const score = clamp(
    (facts.inactivityDays ?? 0) * 2 +
      Math.max(0, 14 - (facts.daysToClose ?? 14)) * 4 +
      Math.min(facts.responseLatencyHours ?? 0, 72) / 3,
  );
  const value = score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";
  return { value, numericValue: score, reasonCode: `urgency_${value.toLowerCase()}` };
};

export const calculateDealRisk: StateCalculator = (facts) => {
  if (
    facts.inactivityDays == null &&
    facts.responseLatencyHours == null &&
    facts.engagementDelta == null
  ) {
    return unknown("insufficient_risk_facts");
  }
  const score = clamp(
    (facts.inactivityDays ?? 0) * 2.5 +
      Math.min(facts.responseLatencyHours ?? 0, 120) / 4 +
      Math.max(0, -(facts.engagementDelta ?? 0)) * 40 +
      (facts.negativeSignals ?? 0) * 8 -
      (facts.positiveSignals ?? 0) * 4,
  );
  const value = score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";
  return { value, numericValue: score, reasonCode: `risk_${value.toLowerCase()}` };
};

export const calculateBuyingStage: StateCalculator = (facts) => {
  if (!facts.stage) return unknown("stage_missing");
  const stage = facts.stage.trim().toUpperCase();
  const normalised =
    stage.includes("COMMIT") || stage === "CLOSED_WON"
      ? "COMMITMENT"
      : stage.includes("NEGOT")
        ? "NEGOTIATION"
        : stage.includes("EVAL") || stage.includes("PROPOS")
          ? "EVALUATION"
          : stage.includes("DISC") || stage.includes("QUAL")
            ? "DISCOVERY"
            : "UNKNOWN";
  return { value: normalised, reasonCode: `stage_${normalised.toLowerCase()}` };
};

export const calculateContactIntent: StateCalculator = (facts) => {
  if (facts.engagementDelta == null && facts.positiveSignals == null) {
    return unknown("insufficient_intent_facts");
  }
  const score = clamp(
    40 + (facts.engagementDelta ?? 0) * 50 + (facts.positiveSignals ?? 0) * 12 -
      (facts.negativeSignals ?? 0) * 10,
  );
  const value = score >= 70 ? "HIGH" : score >= 35 ? "MEDIUM" : "LOW";
  return { value, numericValue: score, reasonCode: `intent_${value.toLowerCase()}` };
};

export const calculateContactRelationship: StateCalculator = (facts) => {
  if (
    facts.relationshipStrength == null &&
    facts.touchCount == null &&
    facts.inactivityDays == null
  ) {
    return unknown("insufficient_relationship_facts");
  }
  const explicit = (facts.relationshipStrength ?? 0) <= 1
    ? (facts.relationshipStrength ?? 0) * 100
    : (facts.relationshipStrength ?? 0);
  const score = clamp(
    explicit * 0.6 +
      Math.min(facts.touchCount ?? 0, 10) * 4 -
      Math.min(facts.inactivityDays ?? 0, 60) * 0.75,
  );
  const value = score >= 70 ? "STRONG" : score >= 35 ? "DEVELOPING" : "WEAK";
  return { value, numericValue: score, reasonCode: `relationship_${value.toLowerCase()}` };
};

export const calculateContactFit: StateCalculator = (facts) => {
  if (facts.fitScore == null) return unknown("fit_score_missing");
  const score = clamp(facts.fitScore <= 1 ? facts.fitScore * 100 : facts.fitScore);
  const value = score >= 70 ? "HIGH" : score >= 35 ? "MEDIUM" : "LOW";
  return { value, numericValue: score, reasonCode: `fit_${value.toLowerCase()}` };
};

export const calculateChannelEngagement: StateCalculator = (facts) => {
  if (facts.engagementDelta == null) return unknown("engagement_delta_missing");
  const value =
    facts.engagementDelta > 0.05
      ? "GROWING"
      : facts.engagementDelta < -0.05
        ? "DECLINING"
        : "STABLE";
  return {
    value,
    numericValue: facts.engagementDelta,
    reasonCode: `engagement_${value.toLowerCase()}`,
  };
};

export const calculateChannelSaturation: StateCalculator = (facts) => {
  if (facts.saturationRate == null) return unknown("saturation_rate_missing");
  const rate = clamp(facts.saturationRate <= 1 ? facts.saturationRate * 100 : facts.saturationRate);
  const value = rate >= 75 ? "HIGH" : rate >= 40 ? "MEDIUM" : "LOW";
  return { value, numericValue: rate, reasonCode: `saturation_${value.toLowerCase()}` };
};

export const calculateChannelStrength: StateCalculator = (facts) => {
  if (facts.engagementRate == null && facts.engagementDelta == null) {
    return unknown("insufficient_channel_strength_facts");
  }
  const engagement = clamp(
    (facts.engagementRate ?? 0) <= 1
      ? (facts.engagementRate ?? 0) * 100
      : (facts.engagementRate ?? 0),
  );
  const saturation = clamp(
    (facts.saturationRate ?? 0) <= 1
      ? (facts.saturationRate ?? 0) * 100
      : (facts.saturationRate ?? 0),
  );
  const score = clamp(engagement * 0.7 + (facts.engagementDelta ?? 0) * 40 - saturation * 0.25);
  const value = score >= 65 ? "STRONG" : score >= 30 ? "MODERATE" : "WEAK";
  return { value, numericValue: score, reasonCode: `channel_strength_${value.toLowerCase()}` };
};

export const STATE_CALCULATORS: Readonly<Record<string, StateCalculator>> = {
  deal_urgency_v1: calculateDealUrgency,
  deal_risk_v1: calculateDealRisk,
  deal_buying_stage_v1: calculateBuyingStage,
  contact_intent_v1: calculateContactIntent,
  contact_relationship_v1: calculateContactRelationship,
  contact_fit_v1: calculateContactFit,
  channel_engagement_v1: calculateChannelEngagement,
  channel_saturation_v1: calculateChannelSaturation,
  channel_strength_v1: calculateChannelStrength,
};

export function getStateCalculator(calculatorKey: string) {
  return STATE_CALCULATORS[calculatorKey];
}
