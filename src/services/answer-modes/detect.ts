import type { AgentAnswerMode } from "@prisma/client";
import type { Clarification } from "@/agents/supervisor/types";

export const ANSWER_MODE_FORMAT_OPTIONS = [
  "Quick Answer",
  "Executive Brief",
  "Action Plan",
  "Deep Report",
] as const;

export type AnswerModeFormatOption = (typeof ANSWER_MODE_FORMAT_OPTIONS)[number];

const FORMAT_OPTION_TO_MODE: Record<string, AgentAnswerMode> = {
  "Quick Answer": "QUICK",
  "Executive Brief": "EXECUTIVE",
  "Action Plan": "ACTION",
  "Deep Report": "DEEP",
};

const MODE_ALIASES: Record<string, AgentAnswerMode> = {
  QUICK: "QUICK",
  EXECUTIVE: "EXECUTIVE",
  ACTION: "ACTION",
  DEEP: "DEEP",
  quick: "QUICK",
  executive: "EXECUTIVE",
  action: "ACTION",
  deep: "DEEP",
};

export function parseAnswerMode(value: unknown): AgentAnswerMode | null {
  if (typeof value !== "string") return null;
  return MODE_ALIASES[value.trim()] ?? null;
}

export function answerModeFromFormatOption(option: string): AgentAnswerMode | null {
  return FORMAT_OPTION_TO_MODE[option.trim()] ?? null;
}

/**
 * Conservative language detection. Returns null unless the format is explicit.
 */
export function detectAnswerModeFromLanguage(request: string): AgentAnswerMode | null {
  const text = request.trim();
  if (!text) return null;

  // Prefer the most specific / longer phrases first.
  if (
    /\b(detailed report|deep (dive|report|analysis)|comprehensive (report|analysis|brief)|full report)\b/i.test(
      text,
    )
  ) {
    return "DEEP";
  }
  if (
    /\b(exactly what to do|action plan|step[- ]by[- ]step (plan|actions?)|tell me what to do)\b/i.test(
      text,
    )
  ) {
    return "ACTION";
  }
  if (
    /\b(for management|executive (brief|summary|overview)|board (brief|summary)|summarise .{0,40}(for )?management)\b/i.test(
      text,
    )
  ) {
    return "EXECUTIVE";
  }
  if (
    /\b(quick answer|give me a quick|in (a )?nutshell|tl;?dr|just the (headline|answer)|briefly)\b/i.test(
      text,
    )
  ) {
    return "QUICK";
  }

  return null;
}

export function formatClarification(): Clarification {
  return {
    kind: "clarification",
    question: "How would you like this answered?",
    options: [...ANSWER_MODE_FORMAT_OPTIONS],
  };
}

export function isFormatClarificationOption(option: string): boolean {
  return Boolean(answerModeFromFormatOption(option));
}

/** Research / social listening — formats only apply to these paths. */
export function looksLikeResearchOrListening(request: string): boolean {
  const text = request.trim();
  if (
    /\b(social listening|what('?s| is) (trending|getting attention)|high[- ]engagement|hooks and formats|content themes|audience complaints)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return /\b(research|look up|find (out|sources|articles)|investigate|compare|competitive analysis|market scan)\b/i.test(
    text,
  );
}
