/**
 * Phase 14F — Intelligence Quality & Verification Engine (public exports).
 * Maturity: WORKING (deterministic gates). Do not claim LIVE_E2E.
 */

export {
  claimNormalisedKey,
  hostFromUrl,
  lineageKey,
  normaliseClaimText,
} from "@/services/intelligence-quality/normalise";

export {
  averageDimensions,
  emptyDimensions,
  scoreAuthority,
  scoreCorroboration,
  scoreFreshness,
  scoreIndependence,
  scoreNegativeEvidence,
  scoreRelevance,
  scoreSampleSize,
  scoreSocialQuality,
  scoreSurvivorshipRisk,
  type QualityDimensions,
  type SourceAuthorityInput,
} from "@/services/intelligence-quality/dimensions";

export {
  applyQualityGate,
  budgetThresholds,
  gateAllowsHighPriorityOpportunity,
  type GateInput,
} from "@/services/intelligence-quality/gate";

export {
  runVerificationPipeline,
  type ExtractedClaim,
  type PipelineFinding,
  type RelevanceContext,
  type VerificationPipelineInput,
  type VerificationPipelineResult,
} from "@/services/intelligence-quality/pipeline";

export {
  factVerificationAgent,
  researchQualityAgent,
  runVerificationAgents,
  socialIntelligenceCritic,
  type FactVerificationResult,
  type ResearchQualityResult,
  type SocialIntelligenceCriticResult,
} from "@/services/intelligence-quality/agents";

export {
  maybeVerifyOpportunityAfterDetect,
  verifyBusinessOpportunity,
  type VerifyBusinessOpportunityResult,
} from "@/services/intelligence-quality/opportunity";

export {
  buildOpportunityTraceability,
  type OpportunityTraceabilityChain,
  type TraceabilityLink,
} from "@/services/intelligence-quality/traceability";

export {
  assessTrendConfidenceDimensions,
  getTrendConfidenceDimensions,
  type AssessTrendConfidenceInput,
} from "@/services/intelligence-quality/trend-bridge";
