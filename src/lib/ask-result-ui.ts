/**
 * Customer-facing Ask result contract.
 * Sources may exist on the payload for ops/quality; the default view must not list them.
 */
export const ASK_SHOW_SOURCES_BY_DEFAULT = false;

export const ASK_TYPED_ANSWER_TYPES = [
  "strategy",
  "scripts",
  "posting_plan",
  "monetization",
] as const;

export type AskTypedAnswerType = (typeof ASK_TYPED_ANSWER_TYPES)[number];

export const ASK_TYPED_ANSWER_LABELS: Record<AskTypedAnswerType, string> = {
  strategy: "Strategy",
  scripts: "Scripts",
  posting_plan: "Posting plan",
  monetization: "Monetization",
};

/** Client-safe: Instagram/LinkedIn growth Asks should run as Quick research. */
export function looksLikeAskGrowthQuery(text: string): boolean {
  if (/\b(summaris[e]|summarize|echo|repeat it)\b/i.test(text)) return false;
  return (
    /\b(instagram|insta|reels?|tiktok|linkedin|youtube|short[- ]form)\b/i.test(text) &&
    /\b(grow|growth|posting|strategy|content strategy|monetiz|followers?|algorithm)\b/i.test(text)
  );
}
