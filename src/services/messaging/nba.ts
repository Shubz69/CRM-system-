export type NextBestAction =
  | "DO_NOT_CONTACT"
  | "OFFER_MEETING"
  | "BOOK_MEETING"
  | "ASK_QUALIFICATION_QUESTION"
  | "REPLY_NOW"
  | "ESCALATE"
  | "FOLLOW_UP"
  | "CLOSE_CONVERSATION"
  | "WAIT";

export type NextBestActionInput = {
  optedOut?: boolean;
  suppressed?: boolean;
  meetingIntent?: boolean;
  qualified?: boolean;
  qualificationStatus?: string;
  bookingReady?: boolean;
  missingRequiredQualification?: boolean | string[];
  priceObjection?: boolean;
  objectionCategory?: string | null;
  highRisk?: boolean;
  highIntent?: boolean;
  stalled?: boolean;
  followUpDue?: boolean;
  conversationComplete?: boolean;
  shouldClose?: boolean;
  needsReply?: boolean;
};

export type NextBestActionDecision = {
  action: NextBestAction;
  priorityClass: string;
  factors: Array<{ key: string; value: string | number | boolean; reason: string }>;
  confidenceBand: "HIGH" | "MEDIUM" | "LOW";
};

function decision(
  action: NextBestAction,
  priorityClass: string,
  factors: NextBestActionDecision["factors"],
  confidenceBand: NextBestActionDecision["confidenceBand"] = "HIGH",
): NextBestActionDecision {
  return { action, priorityClass, factors, confidenceBand };
}

export function decideNextBestAction(
  input: NextBestActionInput,
): NextBestActionDecision {
  if (input.optedOut || input.suppressed) {
    return decision("DO_NOT_CONTACT", "BLOCKED", [
      {
        key: input.optedOut ? "optedOut" : "suppressed",
        value: true,
        reason: "Contactability policy prohibits outbound messaging",
      },
    ]);
  }

  if (input.conversationComplete) {
    const action = input.shouldClose ? "CLOSE_CONVERSATION" : "WAIT";
    return decision(action, "COMPLETE", [
      {
        key: "conversationComplete",
        value: true,
        reason: "No further outbound action is currently needed",
      },
    ]);
  }

  const qualified =
    input.qualified === true || input.qualificationStatus === "QUALIFIED";
  if (input.meetingIntent && qualified) {
    return decision(
      input.bookingReady ? "BOOK_MEETING" : "OFFER_MEETING",
      "HOT_LEAD",
      [
        {
          key: "meetingIntent",
          value: true,
          reason: "The contact explicitly signalled meeting intent",
        },
        {
          key: "qualified",
          value: true,
          reason: "Required qualification is complete",
        },
      ],
    );
  }

  const missingQualification =
    input.missingRequiredQualification === true ||
    (Array.isArray(input.missingRequiredQualification) &&
      input.missingRequiredQualification.length > 0);
  if (missingQualification) {
    return decision("ASK_QUALIFICATION_QUESTION", "REPLY_NEEDED", [
      {
        key: "missingRequiredQualification",
        value: Array.isArray(input.missingRequiredQualification)
          ? input.missingRequiredQualification.join(",")
          : true,
        reason: "A required qualification fact is still missing",
      },
    ]);
  }

  const priceObjection =
    input.priceObjection || input.objectionCategory?.toUpperCase() === "PRICE";
  if (priceObjection) {
    return decision(input.highRisk ? "ESCALATE" : "REPLY_NOW", "REPLY_NEEDED", [
      {
        key: "priceObjection",
        value: true,
        reason: input.highRisk
          ? "A high-risk objection needs human judgment"
          : "The stated price concern should be addressed directly",
      },
    ]);
  }

  if (input.highIntent && input.stalled) {
    const action = input.followUpDue ? "FOLLOW_UP" : "WAIT";
    return decision(action, "HIGH_INTENT_STALL", [
      {
        key: "highIntentStall",
        value: true,
        reason: input.followUpDue
          ? "A policy-approved follow-up is due"
          : "Intent is high but the follow-up interval has not elapsed",
      },
    ], "MEDIUM");
  }

  return decision(input.needsReply === false ? "WAIT" : "REPLY_NOW", "NORMAL", [
    {
      key: "needsReply",
      value: input.needsReply !== false,
      reason:
        input.needsReply === false
          ? "No unanswered contact message is present"
          : "The conversation has an unanswered message",
    },
  ], "MEDIUM");
}
