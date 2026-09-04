/**
 * Research authority helpers — high-stakes / regulatory classification and
 * primary-source domain matching. Not legal advice; retrieval preference only.
 */

export type ResearchStakesClass =
  | "HIGH_STAKES_REGULATORY"
  | "GENERAL";

export type SourceAuthorityTier = "A" | "B" | "C" | "D" | "E";

/** Official / regulator / legislation domains (UK-focused + common globals). */
export const PRIMARY_AUTHORITY_HOST_PATTERNS: RegExp[] = [
  /(^|\.)ico\.org\.uk$/i,
  /(^|\.)legislation\.gov\.uk$/i,
  /(^|\.)gov\.uk$/i,
  /(^|\.)ons\.gov\.uk$/i,
  /\.gov$/i,
  /(^|\.)europa\.eu$/i,
  /(^|\.)oecd\.org$/i,
  /(^|\.)imf\.org$/i,
  /(^|\.)worldbank\.org$/i,
];

export function classifyResearchStakes(prompt: string): ResearchStakesClass {
  const p = prompt.toLowerCase();
  if (
    /\b(gdpr|uk gdpr|data protection|privacy law|legal|compliance|regulation|regulatory|ico|tax law|hmrc|fca|financial conduct|official policy|legislation)\b/i.test(
      p,
    )
  ) {
    return "HIGH_STAKES_REGULATORY";
  }
  return "GENERAL";
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isPrimaryAuthorityUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return PRIMARY_AUTHORITY_HOST_PATTERNS.some((re) => re.test(host));
}

export function tierForAuthorityHost(host: string): SourceAuthorityTier {
  if (!host) return "E";
  if (PRIMARY_AUTHORITY_HOST_PATTERNS.some((re) => re.test(host))) return "A";
  if (/\.edu\b|nature\.com|sciencedirect|ieee\.org|acm\.org/i.test(host)) return "A";
  if (/reuters|bloomberg|ft\.com|wsj\.com|bbc\.|theguardian|nytimes|law\.com|legalcheek/i.test(host))
    return "B";
  if (/linkedin\.com|youtube\.com|youtu\.be|instagram\.com|tiktok\.com/i.test(host)) return "C";
  if (/medium\.com|substack\.com|blogspot|wordpress/i.test(host)) return "D";
  // Vendor marketing / unknown commercial blogs — weak for regulatory claims
  if (
    /crm|saas|software|agency|marketing|blog|insights|guide-202|compliance-guide/i.test(host)
  ) {
    return "D";
  }
  return "C";
}

/**
 * Authority-first query expansions for high-stakes UK regulatory topics.
 * Bounded; does not invent answers — only biases retrieval.
 */
export function authorityFirstQueries(topic: string): string[] {
  const stakes = classifyResearchStakes(topic);
  if (stakes !== "HIGH_STAKES_REGULATORY") return [];

  const base = topic.replace(/\s+/g, " ").trim().slice(0, 180);
  const queries: string[] = [];

  if (/\bgdpr|data protection|privacy|contact details|crm\b/i.test(topic)) {
    queries.push(
      `site:ico.org.uk ${base}`,
      `site:gov.uk UK GDPR storing personal data CRM`,
      `site:legislation.gov.uk UK GDPR`,
      `ICO guidance lawful basis personal data CRM`,
    );
  } else {
    queries.push(
      `site:gov.uk ${base}`,
      `site:legislation.gov.uk ${base}`,
      `${base} official guidance regulator`,
    );
  }

  return [...new Set(queries)].slice(0, 6);
}

/** Cap for sourceQuality when high-stakes and zero primary authorities. */
export const HIGH_STAKES_NO_PRIMARY_SOURCE_QUALITY_CAP = 35;
