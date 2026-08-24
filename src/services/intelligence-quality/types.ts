/**
 * Phase 14F — shared types for the verification pipeline.
 */

import type { IntelligenceClaimStatus, VerificationBudget } from "@prisma/client";
import type { QualityDimensions, SourceAuthorityInput } from "@/services/intelligence-quality/dimensions";

export type PipelineFinding = {
  claimText: string;
  evidenceExcerpt?: string | null;
  claimKind?: string | null;
  researchFindingId?: string | null;
  researchSourceId?: string | null;
  researchSnapshotId?: string | null;
  researchJobId?: string | null;
  providerKey?: string | null;
  sourceUrl?: string | null;
  platform?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  retrievedAt?: Date | null;
  contentHash?: string | null;
  /** false = contradicts the claim / negative evidence */
  supports?: boolean;
  engagement?: {
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    followers?: number | null;
  } | null;
  sampleSize?: number | null;
  authorityTier?: SourceAuthorityInput["tier"];
};

export type RelevanceContext = {
  audienceKeywords?: string[];
  targetPlatforms?: string[];
  targetGeos?: string[];
};

export type ExtractedClaim = {
  text: string;
  normalisedText: string;
  normalisedKey: string;
  claimKind: string;
  status: IntelligenceClaimStatus;
  supportingCount: number;
  contradictingCount: number;
  uniqueLineages: number;
  evidence: Array<{
    findingIndex: number;
    lineage: string;
    supports: boolean;
    researchFindingId?: string | null;
    researchSourceId?: string | null;
    researchSnapshotId?: string | null;
    providerKey?: string | null;
    sourceUrl?: string | null;
    retrievedAt?: Date | null;
    excerpt?: string | null;
  }>;
  dimensions: QualityDimensions;
};

export type VerificationPipelineInput = {
  findings: PipelineFinding[];
  budget?: VerificationBudget;
  relevance?: RelevanceContext;
  now?: Date;
  /** Advisory LLM prose only — never flips the gate. */
  llmCriticNotes?: string | null;
  consequenceLevel?: string;
};
