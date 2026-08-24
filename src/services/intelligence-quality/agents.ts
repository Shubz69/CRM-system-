/**
 * Phase 14F — Fact Verification / Research Quality / Social Critic agents.
 * Pure deterministic functions first. Optional LLM critic notes NEVER override the gate.
 */

import type { OpportunityQualityGate, VerificationBudget } from "@prisma/client";
import {
  averageDimensions,
  type QualityDimensions,
} from "@/services/intelligence-quality/dimensions";
import { applyQualityGate } from "@/services/intelligence-quality/gate";
import type {
  ExtractedClaim,
  PipelineFinding,
} from "@/services/intelligence-quality/types";

export type FactVerificationResult = {
  agent: "fact_verification";
  claimCount: number;
  corroboratedCount: number;
  conflictedCount: number;
  insufficientCount: number;
  notes: string[];
};

export type ResearchQualityResult = {
  agent: "research_quality";
  dimensions: QualityDimensions;
  average: number;
  gaps: string[];
  notes: string[];
};

export type SocialIntelligenceCriticResult = {
  agent: "social_intelligence_critic";
  /** Advisory only — never used to flip OpportunityQualityGate. */
  criticNotes: string;
  flags: string[];
  /** Always false — LLM path cannot override the gate. */
  gateOverrideAttempted: false;
};

export function factVerificationAgent(input: {
  claims: ExtractedClaim[];
}): FactVerificationResult {
  const notes: string[] = [];
  let corroboratedCount = 0;
  let conflictedCount = 0;
  let insufficientCount = 0;

  for (const claim of input.claims) {
    if (claim.status === "CORROBORATED") corroboratedCount += 1;
    else if (claim.status === "CONFLICTED") conflictedCount += 1;
    else if (claim.status === "INSUFFICIENT" || claim.status === "REJECTED") {
      insufficientCount += 1;
    }
    if (claim.supportingCount === 0) {
      notes.push(`Claim lacks supporting evidence: ${claim.normalisedKey.slice(0, 8)}`);
    }
    if (claim.contradictingCount > 0) {
      notes.push(
        `Claim has ${claim.contradictingCount} contradicting lineage(s): ${claim.normalisedKey.slice(0, 8)}`,
      );
    }
  }

  return {
    agent: "fact_verification",
    claimCount: input.claims.length,
    corroboratedCount,
    conflictedCount,
    insufficientCount,
    notes,
  };
}

export function researchQualityAgent(input: {
  dimensions: QualityDimensions;
  findings: PipelineFinding[];
  budget: VerificationBudget;
}): ResearchQualityResult {
  const gaps: string[] = [];
  const notes: string[] = [];
  const d = input.dimensions;

  if (d.corroboration < 0.4) gaps.push("corroboration");
  if (d.independence < 0.4) gaps.push("independence");
  if (d.freshness < 0.4) gaps.push("freshness");
  if (d.authority < 0.4) gaps.push("authority");
  if (d.sampleSize < 0.4) gaps.push("sample_size");
  if (d.survivorshipRisk >= 0.7) gaps.push("survivorship");
  if (d.negativeEvidence >= 0.4) gaps.push("negative_evidence");

  const platforms = new Set(
    input.findings.map((f) => f.platform).filter((p): p is string => Boolean(p)),
  );
  if (platforms.size <= 1 && input.findings.length > 1) {
    notes.push("Findings concentrate on a single platform — independence may be overstated.");
  }
  notes.push(
    `Budget=${input.budget}; transparent avg=${averageDimensions(d).toFixed(3)} (not a calibrated %).`,
  );

  return {
    agent: "research_quality",
    dimensions: d,
    average: averageDimensions(d),
    gaps,
    notes,
  };
}

/**
 * Social critic — deterministic flags + optional advisory LLM prose.
 * Notes are stored for operators; they must not change gateStatus.
 */
export function socialIntelligenceCritic(input: {
  findings: PipelineFinding[];
  dimensions: QualityDimensions;
  llmNotes?: string | null;
}): SocialIntelligenceCriticResult {
  const flags: string[] = [];
  const d = input.dimensions;

  if (d.socialQuality < 0.4) flags.push("weak_social_quality");
  if (d.survivorshipRisk >= 0.7) flags.push("survivorship_bias");
  if (d.sampleSize < 0.35) flags.push("tiny_sample");

  for (const f of input.findings) {
    const views = f.engagement?.views ?? 0;
    const followers = f.engagement?.followers ?? 0;
    if (views > 10_000 && followers > 0 && followers < 500) {
      flags.push("anomalous_engagement_spike");
      break;
    }
  }

  const deterministic =
    flags.length > 0
      ? `Deterministic social flags: ${flags.join(", ")}.`
      : "No deterministic social quality flags.";
  const criticNotes = [deterministic, input.llmNotes?.trim()].filter(Boolean).join("\n");

  return {
    agent: "social_intelligence_critic",
    criticNotes,
    flags,
    gateOverrideAttempted: false,
  };
}

/** Compose agent outputs; gate remains authoritative (ignores critic notes). */
export function runVerificationAgents(input: {
  claims: ExtractedClaim[];
  findings: PipelineFinding[];
  dimensions: QualityDimensions;
  budget: VerificationBudget;
  contradictingCount: number;
  supportingCount: number;
  llmCriticNotes?: string | null;
}): {
  fact: FactVerificationResult;
  research: ResearchQualityResult;
  critic: SocialIntelligenceCriticResult;
  gateStatus: OpportunityQualityGate;
} {
  const fact = factVerificationAgent({ claims: input.claims });
  const research = researchQualityAgent({
    dimensions: input.dimensions,
    findings: input.findings,
    budget: input.budget,
  });
  const critic = socialIntelligenceCritic({
    findings: input.findings,
    dimensions: input.dimensions,
    llmNotes: input.llmCriticNotes,
  });
  const gateStatus = applyQualityGate({
    dimensions: input.dimensions,
    budget: input.budget,
    contradictingCount: input.contradictingCount,
    supportingCount: input.supportingCount,
  });
  return { fact, research, critic, gateStatus };
}
