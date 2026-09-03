import { stripClarificationMetadata, isInternalClarificationOption } from "@/lib/agent-request-sanitize";
import {
  RESEARCH_ACCEPTANCE,
  RESEARCH_QUALITY_WEIGHTS,
  type ClaimKindLabel,
  type ResearchHardGateFailure,
  type ResearchQualityReport,
  type ScoreResearchInput,
  type SourceTier,
} from "./types";

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

const GEO_MARKERS = [
  "uk",
  "united kingdom",
  "britain",
  "england",
  "scotland",
  "wales",
  "us",
  "usa",
  "united states",
  "europe",
  "eu",
  "australia",
  "canada",
  "india",
];

const SIZE_MARKERS = ["sme", "smb", "startup", "enterprise", "mid-market", "fortune", "sole trader"];

function extractConstraintTokens(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const found: string[] = [];
  for (const g of GEO_MARKERS) {
    if (new RegExp(`\\b${g.replace(/\s+/g, "\\s+")}\\b`, "i").test(lower)) found.push(g);
  }
  for (const s of SIZE_MARKERS) {
    if (new RegExp(`\\b${s}\\b`, "i").test(lower)) found.push(s);
  }
  const year = lower.match(/\b(20\d{2})\b/);
  if (year) found.push(year[1]!);
  if (/\blinkedin\b/i.test(lower)) found.push("linkedin");
  if (/\binstagram\b|\breels?\b/i.test(lower)) found.push("instagram");
  if (/\byoutube\s*shorts?\b|\bshorts\b/i.test(lower)) found.push("youtube_short");
  if (/\btiktok\b/i.test(lower)) found.push("tiktok");
  return [...new Set(found)];
}

function scorePromptFidelity(input: ScoreResearchInput): {
  score: number;
  failures: ResearchHardGateFailure[];
} {
  const failures: ResearchHardGateFailure[] = [];
  const prompt = stripClarificationMetadata(input.originalUserPrompt);
  const topic = stripClarificationMetadata(input.researchTopic);
  const answer = (input.finalAnswerText || "").toLowerCase();

  if (isInternalClarificationOption(topic) || /\[user chose:/i.test(input.researchTopic)) {
    failures.push({
      code: "CROSS_RUN_CONTAMINATION",
      message: "Research topic contains internal clarification metadata or option chrome.",
    });
  }

  if (
    input.previousRunPrompt &&
    input.previousRunPrompt.trim() &&
    input.previousRunPrompt.trim() !== prompt.trim()
  ) {
    const prevTokens = tokenize(input.previousRunPrompt).filter((t) => t.length >= 5);
    const promptSet = new Set(tokenize(prompt));
    const leaked = prevTokens.filter((t) => !promptSet.has(t) && answer.includes(t));
    if (leaked.length >= 3) {
      failures.push({
        code: "CROSS_RUN_CONTAMINATION",
        message: "Answer appears to include material from a previous Ask run.",
      });
    }
  }

  const constraints = extractConstraintTokens(prompt);
  let hit = 0;
  for (const c of constraints) {
    const inTopicOrAnswer =
      topic.toLowerCase().includes(c) ||
      answer.includes(c) ||
      (c === "uk" && (answer.includes("united kingdom") || answer.includes("britain")));
    if (inTopicOrAnswer) hit += 1;
    else {
      failures.push({
        code: "IGNORED_CONSTRAINT",
        message: `Important prompt constraint “${c}” was not reflected in the research topic or answer.`,
      });
    }
  }

  const promptTokens = tokenize(prompt).slice(0, 24);
  const coverage =
    promptTokens.length === 0
      ? 50
      : (promptTokens.filter((t) => topic.toLowerCase().includes(t) || answer.includes(t)).length /
          promptTokens.length) *
        100;

  const constraintScore =
    constraints.length === 0 ? 100 : Math.round((hit / constraints.length) * 100);
  let score = Math.round(coverage * 0.55 + constraintScore * 0.45);

  if (input.requestedSocialPlatform && input.socialPlatformAdvice?.length) {
    const wrong = input.socialPlatformAdvice.filter((p) => {
      if (input.requestedSocialPlatform === "youtube_short") {
        return p === "tiktok" || p === "reel" || p === "instagram";
      }
      if (input.requestedSocialPlatform === "tiktok") {
        return p === "youtube_short" || p === "reel" || p === "instagram";
      }
      return false;
    });
    if (wrong.length) {
      score -= 25;
      failures.push({
        code: "WRONG_INTENT",
        message: "Social advice appears cross-labeled across platforms (e.g. Reels guidance for Shorts/TikTok).",
      });
    }
  }

  // Intent mismatch: social/viral plan language for factual business prompts
  const factualAsk =
    /\b(sme|adoption|statistic|market size|how many|what is|pricing|benchmark)\b/i.test(prompt) &&
    !/\b(viral|trending|hooks?|reels?|shorts?|algorithm)\b/i.test(prompt);
  if (factualAsk && /\b(viral talk|algorithm|hooks? and formats|trending posts)\b/i.test(answer)) {
    score -= 20;
    failures.push({
      code: "WRONG_INTENT",
      message: "Business-factual prompt received a social/viral research framing.",
    });
  }

  return { score: clamp(score), failures };
}

function scoreBusinessRelevance(input: ScoreResearchInput): number {
  if (!input.businessSpecific) {
    // Generic research — neutral high score when no org distortion expected
    return 92;
  }
  const snippets = (input.businessContextSnippets || []).map((s) => s.toLowerCase()).filter(Boolean);
  if (!snippets.length) return 70;
  const answer = (input.finalAnswerText || "").toLowerCase();
  const hits = snippets.filter((s) => {
    const words = tokenize(s).slice(0, 6);
    return words.some((w) => answer.includes(w));
  }).length;
  const ratio = hits / Math.max(1, Math.min(snippets.length, 5));
  return clamp(55 + ratio * 45);
}

function looksFabricatedUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true;
  try {
    const u = new URL(url);
    if (!u.hostname.includes(".")) return true;
    if (/example\.com|placeholder|localhost|invalid\.test/i.test(u.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

function scoreFactualAccuracy(input: ScoreResearchInput): {
  score: number;
  failures: ResearchHardGateFailure[];
  claimConfidences: ResearchQualityReport["claimConfidences"];
} {
  const failures: ResearchHardGateFailure[] = [];
  const claimConfidences: ResearchQualityReport["claimConfidences"] = [];
  const allowed = new Set(input.sources.map((s) => s.url));

  if (!input.claims.length && input.sources.length === 0) {
    failures.push({
      code: "UNSUPPORTED_DEFINITIVE_CLAIM",
      message: "No claims or sources available to verify.",
    });
    return { score: 0, failures, claimConfidences };
  }

  let grounded = 0;
  for (const c of input.claims) {
    const url = c.sourceUrl || "";
    const kind = mapClaimKind(c.claimKind);
    let conf = typeof c.confidence === "number" ? Math.round(c.confidence * 100) : 55;
    if (!url || !allowed.has(url) || looksFabricatedUrl(url)) {
      conf = Math.min(conf, 15);
      if (url && looksFabricatedUrl(url)) {
        failures.push({
          code: "FABRICATED_URL",
          message: `Claim cites a non-reviewable or fabricated URL.`,
        });
      } else if (url && !allowed.has(url)) {
        failures.push({
          code: "FABRICATED_URL",
          message: "Claim cites a URL that was not in the collected source set.",
        });
      } else {
        failures.push({
          code: "UNSUPPORTED_DEFINITIVE_CLAIM",
          message: "Claim has no traceable source URL.",
        });
      }
    } else if (c.evidenceExcerpt && c.evidenceExcerpt.trim().length >= 12) {
      grounded += 1;
      conf = Math.max(conf, 70);
    } else {
      grounded += 0.6;
      conf = Math.min(conf, 65);
    }
    claimConfidences.push({ claim: c.claim.slice(0, 200), confidence: clamp(conf), kind });
  }

  // Fabricated person/company heuristic: proper nouns in answer with zero source overlap
  const answer = input.finalAnswerText || "";
  const proper = answer.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g) || [];
  for (const name of proper.slice(0, 8)) {
    const lower = name.toLowerCase();
    if (["United Kingdom", "Agent Desk", "YouTube", "LinkedIn", "TikTok"].includes(name)) continue;
    const inSources = input.sources.some(
      (s) =>
        (s.title || "").toLowerCase().includes(lower) ||
        (s.url || "").toLowerCase().includes(lower.replace(/\s+/g, "")),
    );
    const inPrompt = input.originalUserPrompt.toLowerCase().includes(lower);
    if (!inSources && !inPrompt && name.split(" ").length >= 2) {
      failures.push({
        code: "FABRICATED_ENTITY",
        message: `Named entity “${name}” is not supported by collected sources or the user prompt.`,
      });
      break;
    }
  }

  if (
    input.organisationId &&
    input.outputOrganisationId &&
    input.organisationId !== input.outputOrganisationId
  ) {
    failures.push({
      code: "WRONG_ORG",
      message: "Research output organisation does not match the active workspace.",
    });
  }

  const denom = Math.max(1, input.claims.length);
  const score = input.claims.length
    ? clamp((grounded / denom) * 100)
    : input.sources.length
      ? 60
      : 0;
  return { score, failures, claimConfidences };
}

function mapClaimKind(raw?: string): ClaimKindLabel {
  const k = (raw || "").toUpperCase();
  if (k === "OFFICIAL" || k === "OBSERVATION" || k === "FACT") return "FACT";
  if (k === "INFERENCE") return "INFERENCE";
  if (k === "RECOMMENDATION" || k === "SECONDARY") return k === "RECOMMENDATION" ? "RECOMMENDATION" : "INFERENCE";
  return "UNKNOWN";
}

function tierForSource(s: ScoreResearchInput["sources"][number]): SourceTier {
  const host = (() => {
    try {
      return new URL(s.url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  // UK primary / regulator preference (GDPR, consumer, official stats)
  if (
    /\bico\.org\.uk\b|legislation\.gov\.uk\b|\.gov\.uk\b|ons\.gov|europa\.eu|worldbank|oecd|imf\.org/i.test(
      host,
    )
  ) {
    return "A";
  }
  if (/\.gov\b|\.edu\b|nature\.com|sciencedirect|ieee\.org|acm\.org/i.test(host)) return "A";
  if (/reuters|bloomberg|ft\.com|wsj\.com|bbc\.|theguardian|nytimes/i.test(host)) return "B";
  if (/linkedin\.com|youtube\.com|youtu\.be|instagram\.com|tiktok\.com/i.test(host)) return "C";
  if (/medium\.com|substack\.com|blogspot|wordpress/i.test(host)) return "D";
  if (!host) return "E";
  return "C";
}

function scoreSourceQuality(input: ScoreResearchInput): number {
  if (!input.sources.length) return 0;
  const tiers = input.sources.map(tierForSource);
  const points = tiers.map((t) => ({ A: 100, B: 85, C: 65, D: 40, E: 15 })[t]);
  const avg = points.reduce((a, b) => a + b, 0) / points.length;
  // Penalise promoting only weak tiers when many sources claimed
  const weakOnly = tiers.every((t) => t === "D" || t === "E");
  return clamp(weakOnly ? avg * 0.7 : avg);
}

function scoreCrossVerification(input: ScoreResearchInput): number {
  const byUrl = new Map<string, number>();
  for (const c of input.claims) {
    if (!c.sourceUrl) continue;
    byUrl.set(c.sourceUrl, (byUrl.get(c.sourceUrl) || 0) + 1);
  }
  const unique = byUrl.size;
  const multiSourceClaims = input.claims.filter((c) => {
    if (!c.sourceUrl) return false;
    // crude: same claim fragment appears with different urls
    const others = input.claims.filter(
      (o) => o.sourceUrl && o.sourceUrl !== c.sourceUrl && overlap(c.claim, o.claim),
    );
    return others.length > 0;
  }).length;
  let score = 40;
  if (unique >= 3) score += 25;
  if (unique >= 5) score += 15;
  if (multiSourceClaims > 0) score += 20;
  if ((input.contradictions || []).length > 0) score += 10; // honest disagreement surfaced
  if (unique <= 1 && input.claims.length > 2) score -= 25; // weak single-source pack
  return clamp(score);
}

function overlap(a: string, b: string): boolean {
  const ta = new Set(tokenize(a));
  const tb = tokenize(b);
  const hits = tb.filter((t) => ta.has(t)).length;
  return hits >= 3;
}

function scoreFreshness(input: ScoreResearchInput): number {
  if (!input.sources.length) return 40;
  const scores = input.sources.map((s) => {
    if (typeof s.freshnessScore === "number") return s.freshnessScore * 100;
    if (!s.publishedAt) return 50;
    const t = new Date(s.publishedAt).getTime();
    if (!Number.isFinite(t)) return 50;
    const ageDays = (Date.now() - t) / (86400 * 1000);
    if (ageDays <= 30) return 95;
    if (ageDays <= 180) return 80;
    if (ageDays <= 365) return 65;
    if (ageDays <= 730) return 45;
    return 25;
  });
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  // Intent: factual/market research shouldn't over-reward freshness vs authority
  const factual = /\b(adoption|statistic|regulation|definition|what is)\b/i.test(
    input.originalUserPrompt,
  );
  return clamp(factual ? avg * 0.85 + 15 : avg);
}

function scoreUncertainty(input: ScoreResearchInput): number {
  // Higher = better uncertainty handling (disclosures present when needed)
  const gaps = input.gaps || [];
  const contradictions = input.contradictions || [];
  const singleSource = new Set(input.claims.map((c) => c.sourceUrl).filter(Boolean)).size <= 1;
  let score = 70;
  if (singleSource && input.claims.length > 0) {
    const disclosed = gaps.some((g) => /single|only one|limited|unverif/i.test(g));
    score = disclosed ? 85 : 35;
  }
  if (contradictions.length) {
    score = Math.max(score, 80);
  }
  if (gaps.length >= 1) score = Math.max(score, 75);
  if (!gaps.length && !contradictions.length && input.claims.length > 5 && singleSource) {
    score = 25;
  }
  return clamp(score);
}

function confidenceLabel(
  overall: number,
  accepted: boolean,
): ResearchQualityReport["confidenceLabel"] {
  if (!accepted) return "Not accepted";
  if (overall >= 90) return "High confidence";
  if (overall >= 75) return "Moderate confidence";
  return "Low confidence";
}

/**
 * Score a research answer. Deterministic heuristics — must NOT always return high scores.
 * When evidence is missing, fail the quality gate honestly instead of inventing a mid % like 48.
 */
export function scoreResearchQuality(input: ScoreResearchInput): ResearchQualityReport {
  const hasEvidence = input.claims.length > 0 || input.sources.length > 0;
  if (!hasEvidence) {
    return {
      version: 1,
      overall: 0,
      confidenceLabel: "Not accepted",
      breakdown: {
        promptFidelity: 0,
        businessRelevance: 0,
        factualAccuracy: 0,
        sourceQuality: 0,
        crossVerification: 0,
        freshness: 0,
        uncertainty: 0,
      },
      hardGateFailures: [
        {
          code: "UNSUPPORTED_DEFINITIVE_CLAIM",
          message: "Quality gate failed — not enough verifiable claims or sources to score.",
        },
      ],
      accepted: false,
      claimConfidences: [],
      limitations: ["Quality gate failed — not enough verifiable claims or sources to score."],
      originalUserPrompt: stripClarificationMetadata(input.originalUserPrompt),
      resolvedIntent: input.resolvedIntent ?? null,
      answerMode: input.answerMode ?? null,
    };
  }

  const fidelity = scorePromptFidelity(input);
  const businessRelevance = scoreBusinessRelevance(input);
  const factual = scoreFactualAccuracy(input);
  const sourceQuality = scoreSourceQuality(input);
  const crossVerification = scoreCrossVerification(input);
  const freshness = scoreFreshness(input);
  const uncertainty = scoreUncertainty(input);

  const breakdown = {
    promptFidelity: fidelity.score,
    businessRelevance: clamp(businessRelevance),
    factualAccuracy: factual.score,
    sourceQuality: clamp(sourceQuality),
    crossVerification: clamp(crossVerification),
    freshness: clamp(freshness),
    uncertainty: clamp(uncertainty),
  };

  const weighted = clamp(
    breakdown.promptFidelity * RESEARCH_QUALITY_WEIGHTS.promptFidelity +
      breakdown.businessRelevance * RESEARCH_QUALITY_WEIGHTS.businessRelevance +
      breakdown.factualAccuracy * RESEARCH_QUALITY_WEIGHTS.factualAccuracy +
      breakdown.sourceQuality * RESEARCH_QUALITY_WEIGHTS.sourceQuality +
      breakdown.crossVerification * RESEARCH_QUALITY_WEIGHTS.crossVerification +
      breakdown.freshness * RESEARCH_QUALITY_WEIGHTS.freshness +
      breakdown.uncertainty * RESEARCH_QUALITY_WEIGHTS.uncertainty,
  );

  const hardGateFailures: ResearchHardGateFailure[] = [
    ...fidelity.failures,
    ...factual.failures,
  ];

  if (breakdown.promptFidelity < RESEARCH_ACCEPTANCE.promptFidelityMin) {
    hardGateFailures.push({
      code: "PROMPT_FIDELITY_BELOW_THRESHOLD",
      message: `Prompt fidelity ${breakdown.promptFidelity} is below ${RESEARCH_ACCEPTANCE.promptFidelityMin}.`,
    });
  }
  if (breakdown.factualAccuracy < RESEARCH_ACCEPTANCE.factualAccuracyMin) {
    hardGateFailures.push({
      code: "FACTUAL_ACCURACY_BELOW_THRESHOLD",
      message: `Factual accuracy ${breakdown.factualAccuracy} is below ${RESEARCH_ACCEPTANCE.factualAccuracyMin}.`,
    });
  }
  if (
    input.businessSpecific &&
    breakdown.businessRelevance < RESEARCH_ACCEPTANCE.businessRelevanceMinWhenBusinessSpecific
  ) {
    hardGateFailures.push({
      code: "BUSINESS_RELEVANCE_BELOW_THRESHOLD",
      message: `Business relevance ${breakdown.businessRelevance} is below ${RESEARCH_ACCEPTANCE.businessRelevanceMinWhenBusinessSpecific}.`,
    });
  }

  // High-stakes (GDPR / legal / financial) + only weak sources → never high confidence.
  const highStakes = /\b(gdpr|data protection|privacy|legal|compliance|ico|regulation)\b/i.test(
    input.originalUserPrompt,
  );
  const tiers = input.sources.map(tierForSource);
  const weakOnly = tiers.length > 0 && tiers.every((t) => t === "D" || t === "E" || t === "C");
  if (highStakes && weakOnly) {
    hardGateFailures.push({
      code: "UNSUPPORTED_DEFINITIVE_CLAIM",
      message:
        "High-stakes topic lacks primary sources (prefer ICO, GOV.UK, or legislation.gov.uk).",
    });
  }

  // Deduplicate by code+message
  const seen = new Set<string>();
  const uniqueFailures = hardGateFailures.filter((f) => {
    const k = `${f.code}:${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const accepted =
    uniqueFailures.length === 0 && weighted >= RESEARCH_ACCEPTANCE.overallTarget;

  let confidence = confidenceLabel(weighted, accepted || uniqueFailures.length === 0);
  if (highStakes && weakOnly) {
    confidence = "Not accepted";
  }

  const limitations = [
    ...(input.gaps || []).slice(0, 6),
    ...uniqueFailures.map((f) => f.message),
  ].slice(0, 10);

  return {
    version: 1,
    overall: weighted,
    confidenceLabel: confidence,
    breakdown,
    hardGateFailures: uniqueFailures,
    accepted: accepted && !(highStakes && weakOnly),
    claimConfidences: factual.claimConfidences,
    limitations,
    originalUserPrompt: stripClarificationMetadata(input.originalUserPrompt),
    resolvedIntent: input.resolvedIntent ?? null,
    answerMode: input.answerMode ?? null,
  };
}

export function customerQualitySummary(report: ResearchQualityReport): string {
  if (!report.accepted && report.overall === 0 && report.hardGateFailures.length) {
    return "Quality gate failed — not enough verifiable evidence to score.";
  }
  return `Research quality: ${report.overall}% · ${report.confidenceLabel}`;
}
