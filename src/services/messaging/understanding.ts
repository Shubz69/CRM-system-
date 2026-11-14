import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { planCompute } from "@/services/compute-governor";
import { matchOptOutKeyword } from "@/services/opt-out";

export type L0Understanding = {
  level: "L0";
  intent: "OPT_OUT" | "MEETING" | "PRICE_OBJECTION" | "GENERAL";
  meetingIntent: boolean;
  objectionCategory: "PRICE" | null;
  optedOut: boolean;
  confidenceBand: "HIGH" | "MEDIUM";
  matchedKeywords: string[];
};

const MEETING_PATTERNS = [
  /\b(?:book|schedule|arrange)\b.{0,24}\b(?:meeting|call|demo)\b/i,
  /\b(?:meeting|call|demo)\b.{0,24}\b(?:book|schedule|available)\b/i,
  /\bcalendar\b/i,
];
const PRICE_PATTERNS = [
  /\btoo expensive\b/i,
  /\b(?:price|pricing|cost|budget|discount|afford)\b/i,
];

function matches(text: string, patterns: RegExp[]): string[] {
  return patterns
    .map((pattern) => text.match(pattern)?.[0]?.toLowerCase())
    .filter((value): value is string => Boolean(value));
}

export function classifyInboundL0(text: string): L0Understanding {
  // Same strict rule as the keyword gate: the message must be an opt-out command, not merely
  // contain "stop" ("can't stop thinking about it", "one-stop shop").
  const optOut = matchOptOutKeyword(text);
  if (optOut) {
    return {
      level: "L0",
      intent: "OPT_OUT",
      meetingIntent: false,
      objectionCategory: null,
      optedOut: true,
      confidenceBand: "HIGH",
      matchedKeywords: [optOut],
    };
  }
  const meeting = matches(text, MEETING_PATTERNS);
  if (meeting.length) {
    return {
      level: "L0",
      intent: "MEETING",
      meetingIntent: true,
      objectionCategory: null,
      optedOut: false,
      confidenceBand: "HIGH",
      matchedKeywords: meeting,
    };
  }
  const price = matches(text, PRICE_PATTERNS);
  if (price.length) {
    return {
      level: "L0",
      intent: "PRICE_OBJECTION",
      meetingIntent: false,
      objectionCategory: "PRICE",
      optedOut: false,
      confidenceBand: "HIGH",
      matchedKeywords: price,
    };
  }
  return {
    level: "L0",
    intent: "GENERAL",
    meetingIntent: false,
    objectionCategory: null,
    optedOut: false,
    confidenceBand: "MEDIUM",
    matchedKeywords: [],
  };
}

export async function planUnderstandingCompute(
  organisationId: string,
  text: string,
  prior?: unknown,
) {
  const l0 = classifyInboundL0(text);
  return planCompute({
    organisationId,
    taskType: "classification",
    complexity: "LOW",
    consequence: l0.optedOut ? "HIGH" : "LOW",
    evidenceState: {
      deterministicCapable:
        l0.intent !== "GENERAL" || Boolean(prior),
    },
    contextBudget: 512,
    toolBudget: 0,
  });
}

export async function persistUnderstanding(input: {
  organisationId: string;
  conversationId: string;
  understanding: Partial<L0Understanding> & Record<string, unknown>;
  evidenceMessageIds?: string[];
  version?: number;
  extractorVersion?: string;
  observedAt?: Date;
}) {
  const value = input.understanding;
  return prisma.conversationUnderstanding.create({
    data: {
      organisationId: input.organisationId,
      conversationId: input.conversationId,
      version: input.version ?? 1,
      intent: typeof value.intent === "string" ? value.intent : undefined,
      objectionCategory:
        typeof value.objectionCategory === "string" ? value.objectionCategory : undefined,
      meetingIntent: value.meetingIntent === true,
      confidenceBand:
        typeof value.confidenceBand === "string" ? value.confidenceBand : "LOW",
      evidenceMessageIds: input.evidenceMessageIds ?? [],
      extractorVersion: input.extractorVersion ?? "understand-l0-v1",
      factors: value as Prisma.InputJsonValue,
      observedAt: input.observedAt,
    },
  });
}

export async function runUnderstandingShadow(input: {
  organisationId: string;
  text: string;
  prior?: unknown;
}) {
  const understanding = classifyInboundL0(input.text);
  const computePlan = await planUnderstandingCompute(
    input.organisationId,
    input.text,
    input.prior,
  );
  return {
    understanding,
    computePlan,
    requiresLlm: computePlan.governorMode !== "DETERMINISTIC",
    shadow: true as const,
  };
}
