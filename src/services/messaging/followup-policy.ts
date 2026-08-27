export type FollowUpPolicyInput = {
  intent: string;
  qualificationStatus: string;
  attemptNumber: number;
  maxAttempts: number;
  meetingBooked: boolean;
  optedOut: boolean;
  businessHoursOnly?: boolean;
  lastInboundAt?: Date | string | null;
};

export type NoResponseClassification =
  | "BUSY_OR_DELAYED"
  | "FORGOTTEN"
  | "LIKELY_UNSEEN"
  | "LOW_INTEREST"
  | "HIGH_INTENT_STALLED"
  | "CONVERSATION_COMPLETE"
  | "UNKNOWN";

const COMPLETE_STATUSES = new Set(["QUALIFIED", "NOT_QUALIFIED", "DISQUALIFIED", "COMPLETE"]);
const HIGH_INTENTS = new Set(["BOOKING", "MEETING", "PRICING", "PURCHASE", "BUYING"]);

function normalize(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function planFollowUpSchedule(input: FollowUpPolicyInput): number[] {
  const attempt = Math.max(0, Math.floor(input.attemptNumber));
  const maxAttempts = Math.max(0, Math.floor(input.maxAttempts));
  if (
    input.meetingBooked ||
    input.optedOut ||
    attempt >= maxAttempts ||
    COMPLETE_STATUSES.has(normalize(input.qualificationStatus))
  ) {
    return [];
  }

  const remaining = maxAttempts - attempt;
  const intent = normalize(input.intent);
  const highIntent = HIGH_INTENTS.has(intent) || intent.includes("MEETING");
  const baseMinutes = highIntent ? 4 * 60 : 24 * 60;

  return Array.from({ length: remaining }, (_, index) => {
    const absoluteAttempt = attempt + index;
    const growingCooldown = baseMinutes * 2 ** absoluteAttempt;
    // Twelve-hour increments avoid scheduling a business-hours-only follow-up overnight.
    return input.businessHoursOnly
      ? Math.ceil(growingCooldown / (12 * 60)) * 12 * 60
      : growingCooldown;
  });
}

export function classifyNoResponse(input: {
  daysSinceInbound: number;
  wasQualified: boolean;
  meetingIntent: boolean;
  lastOutboundCount: number;
}): NoResponseClassification {
  if (input.daysSinceInbound < 0 || input.lastOutboundCount < 0) return "UNKNOWN";
  if (input.meetingIntent && input.daysSinceInbound >= 1) return "HIGH_INTENT_STALLED";
  if (input.wasQualified && input.lastOutboundCount === 0) return "LIKELY_UNSEEN";
  if (input.lastOutboundCount >= 4 || input.daysSinceInbound >= 14) return "CONVERSATION_COMPLETE";
  if (input.daysSinceInbound < 1) return "BUSY_OR_DELAYED";
  if (input.lastOutboundCount === 0) return "LIKELY_UNSEEN";
  if (input.daysSinceInbound <= 3) return "FORGOTTEN";
  if (input.lastOutboundCount >= 2) return "LOW_INTEREST";
  return "UNKNOWN";
}
