/**
 * Keep Ask/Research user content free of internal clarification metadata.
 * `[User chose: …]` must never enter topics, search queries, or model prompts.
 */

const USER_CHOSE_RE = /\n\n\[User chose:[^\]]*\]/gi;
const USER_CHOSE_INLINE_RE = /\[User chose:[^\]]*\]/gi;

/** Strip clarification metadata that must never reach research/topic/prompt text. */
export function stripClarificationMetadata(text: string): string {
  return text
    .replace(USER_CHOSE_RE, "")
    .replace(USER_CHOSE_INLINE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the string is only an internal UI option, not a customer question. */
export function isInternalClarificationOption(text: string): boolean {
  const t = text.trim();
  return (
    /^research this topic with sources$/i.test(t) ||
    /^social listening on (this topic|a niche)$/i.test(t) ||
    /^summarise it into a short brief$/i.test(t) ||
    /^repeat it back to me$/i.test(t) ||
    /^create an image from a reference$/i.test(t) ||
    /^i'?m not sure/i.test(t) ||
    /^quick answer$/i.test(t) ||
    /^executive brief$/i.test(t) ||
    /^action plan$/i.test(t) ||
    /^deep report$/i.test(t)
  );
}

/** Topic/query for research agents — never clarification chrome. */
export function sanitizeResearchTopic(raw: string, maxLen = 2000): string {
  const cleaned = stripClarificationMetadata(raw);
  if (!cleaned || isInternalClarificationOption(cleaned)) {
    return "";
  }
  return cleaned.slice(0, maxLen);
}
