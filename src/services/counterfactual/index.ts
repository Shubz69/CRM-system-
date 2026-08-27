/**
 * Phase 20I — transparent counterfactual comparison.
 *
 * No domain events are emitted here; Track J owns event catalogue semantics.
 */
import { CounterfactualMaturity, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const COUNTERFACTUAL_SAMPLE_MINIMUMS = {
  [CounterfactualMaturity.EVIDENCE_COMPARISON]: 0,
  [CounterfactualMaturity.HISTORICAL_SIMILARITY]: 5,
  [CounterfactualMaturity.CALIBRATED_ESTIMATION]: 20,
} as const;

type PotentialValueBand = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

const BAND_SCORE: Record<string, number> = {
  LOW: 1,
  MEDIUM: 0.5,
  HIGH: 0,
  UNKNOWN: 0.25,
};
const CONFIDENCE_SCORE: Record<string, number> = {
  HIGH: 1,
  MEDIUM: 0.6,
  LOW: 0.25,
  UNKNOWN: 0,
};

function normaliseAlignment(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

function metadataRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function evidenceCount(metadata: Record<string, unknown>): number {
  const explicit = Number(metadata.evidenceCount);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  return Array.isArray(metadata.evidenceIds) ? metadata.evidenceIds.length : 0;
}

function potentialValueBand(value: string | null): PotentialValueBand {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH" ? value : "UNKNOWN";
}

export class CounterfactualError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "CounterfactualError";
  }
}

export async function compareAlternatives(input: {
  organisationId: string;
  decisionId: string;
  maturity?: CounterfactualMaturity;
}) {
  const maturity = input.maturity ?? CounterfactualMaturity.EVIDENCE_COMPARISON;
  const decision = await prisma.decision.findFirst({
    where: { id: input.decisionId, organisationId: input.organisationId },
    include: { alternatives: true, evidenceLinks: true },
  });
  if (!decision) throw new CounterfactualError("Decision not found");

  const minimumSamples = COUNTERFACTUAL_SAMPLE_MINIMUMS[maturity];
  const sampleSize =
    minimumSamples === 0
      ? 0
      : await prisma.decisionOutcome.count({
          where: {
            organisationId: input.organisationId,
            attribution: { in: ["DIRECT", "CONTRIBUTED"] },
            decision: { decisionType: decision.decisionType },
          },
        });
  const insufficientEvidence = sampleSize < minimumSamples;

  if (insufficientEvidence) {
    const explanationFactors = [
      {
        factor: "sample_size",
        observed: sampleSize,
        required: minimumSamples,
        explanation: `${maturity} is unavailable until enough attributed historical outcomes exist.`,
      },
    ];
    const run = await prisma.counterfactualRun.create({
      data: {
        organisationId: input.organisationId,
        decisionId: decision.id,
        goalId: decision.goalId,
        opportunityId: decision.opportunityId,
        maturity,
        ranking: [] as Prisma.InputJsonValue,
        explanationFactors: explanationFactors as Prisma.InputJsonValue,
        insufficientEvidence: true,
        metadata: {
          capabilityMaturity: "FOUNDATION",
          availability: "UNAVAILABLE",
          sampleSize,
          minimumSamples,
        },
      },
    });
    return {
      run,
      ranking: [],
      explanationFactors,
      capabilityMaturity: "FOUNDATION" as const,
      availability: "UNAVAILABLE" as const,
      insufficientEvidence: true,
      sampleSize,
      minimumSamples,
    };
  }

  const maxCost = Math.max(
    1,
    ...decision.alternatives.map((alternative) => alternative.estimatedCostCents ?? 0),
  );
  const ranking = decision.alternatives
    .map((alternative) => {
      const metadata = metadataRecord(alternative.metadata);
      const evidence = evidenceCount(metadata);
      const components = {
        goalAlignment: normaliseAlignment(alternative.goalAlignment) * 35,
        lowerRisk: (BAND_SCORE[alternative.riskBand ?? "UNKNOWN"] ?? 0.25) * 20,
        lowerCost: (1 - Math.min(1, (alternative.estimatedCostCents ?? maxCost) / maxCost)) * 15,
        confidence: (CONFIDENCE_SCORE[alternative.confidenceBand ?? "UNKNOWN"] ?? 0) * 20,
        evidence: Math.min(1, evidence / 5) * 10,
      };
      for (const key of Object.keys(components) as Array<keyof typeof components>) {
        components[key] = Number(components[key].toFixed(2));
      }
      const rankScore = Number(
        Object.values(components).reduce((sum, value) => sum + value, 0).toFixed(2),
      );
      return {
        alternativeId: alternative.id,
        alternativeKey: alternative.alternativeKey,
        label: alternative.label,
        rankScore,
        components,
        evidenceCount: evidence,
        potentialValueBand: potentialValueBand(alternative.potentialValueBand),
      };
    })
    .sort(
      (left, right) =>
        right.rankScore - left.rankScore ||
        left.alternativeKey.localeCompare(right.alternativeKey),
    );

  const explanationFactors = ranking.slice(0, -1).map((candidate, index) => {
    const next = ranking[index + 1];
    const advantages = Object.entries(candidate.components)
      .filter(([key, value]) => value > next.components[key as keyof typeof next.components])
      .map(([key]) => key);
    return {
      preferredAlternativeId: candidate.alternativeId,
      overAlternativeId: next.alternativeId,
      scoreDifference: Number((candidate.rankScore - next.rankScore).toFixed(2)),
      factors: advantages,
      explanation: `${candidate.label} ranks above ${next.label} on ${advantages.join(", ") || "deterministic tie-break"}.`,
    };
  });

  const run = await prisma.counterfactualRun.create({
    data: {
      organisationId: input.organisationId,
      decisionId: decision.id,
      goalId: decision.goalId,
      opportunityId: decision.opportunityId,
      maturity,
      ranking: ranking as Prisma.InputJsonValue,
      explanationFactors: explanationFactors as Prisma.InputJsonValue,
      insufficientEvidence: false,
      metadata: {
        capabilityMaturity: "WORKING",
        availability: "AVAILABLE",
        sampleSize,
        minimumSamples,
        scoreFormula:
          "goalAlignment*35 + lowerRisk*20 + lowerCost*15 + confidence*20 + min(evidence/5,1)*10",
        note: "Potential value is a qualitative band; no currency or revenue prediction is generated.",
      },
    },
  });

  return {
    run,
    ranking,
    explanationFactors,
    capabilityMaturity: "WORKING" as const,
    availability: "AVAILABLE" as const,
    insufficientEvidence: false,
    sampleSize,
    minimumSamples,
  };
}
