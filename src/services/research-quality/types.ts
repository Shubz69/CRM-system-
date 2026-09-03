/**
 * Research Quality Engine — scores and hard gates for Ask/Research answers.
 * Research is not "done" merely because it completed or returned JSON.
 */

export type ClaimKindLabel = "FACT" | "INFERENCE" | "RECOMMENDATION" | "UNKNOWN";

export type SourceTier = "A" | "B" | "C" | "D" | "E";

export type ResearchQualityBreakdown = {
  promptFidelity: number;
  businessRelevance: number;
  factualAccuracy: number;
  sourceQuality: number;
  crossVerification: number;
  freshness: number;
  uncertainty: number;
};

export type ResearchHardGateFailure = {
  code:
    | "FABRICATED_ENTITY"
    | "FABRICATED_URL"
    | "FABRICATED_STATISTIC"
    | "WRONG_ORG"
    | "CROSS_RUN_CONTAMINATION"
    | "WRONG_INTENT"
    | "UNSUPPORTED_DEFINITIVE_CLAIM"
    | "IGNORED_CONSTRAINT"
    | "PROMPT_FIDELITY_BELOW_THRESHOLD"
    | "FACTUAL_ACCURACY_BELOW_THRESHOLD"
    | "BUSINESS_RELEVANCE_BELOW_THRESHOLD";
  message: string;
};

export type ResearchQualityReport = {
  version: 1;
  overall: number;
  confidenceLabel: "High confidence" | "Moderate confidence" | "Low confidence" | "Not accepted";
  breakdown: ResearchQualityBreakdown;
  hardGateFailures: ResearchHardGateFailure[];
  accepted: boolean;
  claimConfidences: Array<{ claim: string; confidence: number; kind: ClaimKindLabel }>;
  limitations: string[];
  originalUserPrompt: string;
  resolvedIntent?: string | null;
  answerMode?: string | null;
};

export type ResearchProvenance = {
  originalUserPrompt: string;
  resolvedIntent?: string | null;
  answerMode?: string | null;
  clarifications?: string[];
  businessContextUsed?: string[];
  researchPlan?: string | null;
};

export const RESEARCH_QUALITY_WEIGHTS = {
  promptFidelity: 0.2,
  businessRelevance: 0.2,
  factualAccuracy: 0.25,
  sourceQuality: 0.15,
  crossVerification: 0.1,
  freshness: 0.05,
  uncertainty: 0.05,
} as const;

export const RESEARCH_ACCEPTANCE = {
  overallTarget: 90,
  promptFidelityMin: 95,
  factualAccuracyMin: 95,
  businessRelevanceMinWhenBusinessSpecific: 90,
} as const;

export type ScoreResearchInput = {
  originalUserPrompt: string;
  /** Effective topic sent to research (must not contain prior-run / [User chose] chrome). */
  researchTopic: string;
  previousRunPrompt?: string | null;
  resolvedIntent?: string | null;
  answerMode?: string | null;
  businessSpecific?: boolean;
  businessContextSnippets?: string[];
  organisationId?: string;
  outputOrganisationId?: string;
  claims: Array<{
    claim: string;
    sourceUrl?: string;
    evidenceExcerpt?: string;
    claimKind?: string;
    confidence?: number;
  }>;
  sources: Array<{
    url: string;
    title?: string | null;
    platform?: string | null;
    publishedAt?: string | Date | null;
    freshnessScore?: number | null;
  }>;
  finalAnswerText?: string;
  gaps?: string[];
  contradictions?: Array<{ description: string; sourceUrls?: string[] }>;
  /** Platform-specific social advice detected in answer (for cross-label fail). */
  socialPlatformAdvice?: Array<"linkedin" | "instagram" | "youtube_short" | "tiktok" | "reel">;
  requestedSocialPlatform?: "linkedin" | "instagram" | "youtube_short" | "tiktok" | null;
};
