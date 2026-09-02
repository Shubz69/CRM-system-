/**
 * Customer-facing labels for CRM lead sources — never expose vendor implementation names.
 */
export function formatLeadSource(raw?: string | null): string {
  if (!raw) return "—";
  const s = raw.trim().toLowerCase();
  if (!s) return "—";
  if (s === "simulator") return "Simulator";
  if (s.includes("instagram")) return "Instagram";
  if (s.includes("linkedin")) return "LinkedIn";
  if (s.includes("youtube")) return "YouTube";
  if (s.includes("social_prospecting") || s.includes("prospect")) return "Prospecting";
  if (s.includes("manual") || s.includes("crm")) return "CRM";
  if (s.includes("web") || s.includes("form")) return "Website";
  // Strip known vendor suffixes/prefixes
  const cleaned = raw
    .replace(/zernio|manychat|ayrshare|meta[_-]?adapter|openai|anthropic|claude/gi, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned) return "Social";
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}
