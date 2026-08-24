/**
 * Phase 14F — persist verification onto BusinessOpportunity.
 * Poor evidence must not leave an opportunity as high-priority PASSED.
 */

import {
  IntelligenceClaimStatus,
  OpportunityConfidenceBand,
  type OpportunityQualityGate,
  type Prisma,
  type QualityAssessment,
  type VerificationBudget,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { appendDomainEvent } from "@/services/domain-events/append";
import { gateAllowsHighPriorityOpportunity } from "@/services/intelligence-quality/gate";
import {
  runVerificationPipeline,
  type PipelineFinding,
  type VerificationPipelineResult,
} from "@/services/intelligence-quality/pipeline";
import { computePriorityScore } from "@/services/opportunities/scoring";

const RESEARCH_EVIDENCE_TYPES = new Set([
  "ResearchFinding",
  "ResearchSource",
  "ResearchSourceSnapshot",
]);

export type VerifyBusinessOpportunityResult = {
  assessment: QualityAssessment;
  pipeline: VerificationPipelineResult;
  opportunityId: string;
  gateStatus: OpportunityQualityGate;
};

async function loadFindingsForOpportunity(
  organisationId: string,
  opportunityId: string,
): Promise<PipelineFinding[]> {
  const evidences = await prisma.opportunityEvidence.findMany({
    where: { organisationId, opportunityId },
    orderBy: { createdAt: "asc" },
  });

  const findings: PipelineFinding[] = [];
  const findingIds = evidences
    .filter((e) => e.evidenceType === "ResearchFinding" && e.evidenceId)
    .map((e) => e.evidenceId!);

  if (findingIds.length > 0) {
    const rows = await prisma.researchFinding.findMany({
      where: { organisationId, id: { in: findingIds } },
      include: {
        source: { include: { snapshot: true } },
      },
    });
    for (const row of rows) {
      findings.push({
        claimText: row.claim,
        evidenceExcerpt: row.evidenceExcerpt,
        claimKind: row.claimKind,
        researchFindingId: row.id,
        researchSourceId: row.researchSourceId,
        researchSnapshotId: row.source.snapshot?.id ?? null,
        researchJobId: row.researchJobId,
        providerKey: row.source.platform,
        sourceUrl: row.source.url,
        platform: row.source.platform,
        author: row.source.author,
        publishedAt: row.source.publishedAt,
        retrievedAt: row.source.retrievedAt,
        contentHash: row.source.contentHash,
        supports: !row.flaggedUnsupported && !row.flaggedUngrounded,
        authorityTier:
          row.claimKind === "OFFICIAL"
            ? "first_party"
            : row.claimKind === "OBSERVATION"
              ? "connected_api"
              : "indexed_web",
      });
    }
  }

  // Map remaining durable opportunity evidence as first-party findings (no invention).
  for (const e of evidences) {
    if (e.evidenceType === "ResearchFinding") continue;
    const text = [e.label, e.detail].filter(Boolean).join(": ").trim();
    if (!text) continue;
    findings.push({
      claimText: text,
      evidenceExcerpt: e.detail,
      claimKind: "OBSERVATION",
      providerKey: "crm",
      platform: "crm",
      retrievedAt: e.createdAt,
      supports: true,
      authorityTier: "first_party",
      sampleSize: 1,
    });
  }

  return findings;
}

async function loadRelevanceContext(organisationId: string) {
  const audiences = await prisma.audienceSegment.findMany({
    where: { organisationId },
    take: 20,
    select: { name: true, description: true, attributes: true },
  });
  const audienceKeywords: string[] = [];
  for (const a of audiences) {
    if (a.name) audienceKeywords.push(a.name);
    if (a.description) {
      audienceKeywords.push(
        ...a.description
          .split(/\W+/)
          .filter((t) => t.length >= 4)
          .slice(0, 8),
      );
    }
  }
  return {
    audienceKeywords: [...new Set(audienceKeywords)].slice(0, 40),
    targetPlatforms: [] as string[],
    targetGeos: [] as string[],
  };
}

function confidenceAfterGate(
  gate: OpportunityQualityGate,
  current: OpportunityConfidenceBand,
): OpportunityConfidenceBand {
  if (gateAllowsHighPriorityOpportunity(gate)) return current;
  // Failed gates cannot retain HIGH confidence / priority honesty.
  if (current === "HIGH") return "LOW";
  if (current === "MEDIUM") return "LOW";
  return "LOW";
}

/**
 * Run verification, persist QualityAssessment + claims, update opportunity gate.
 */
export async function verifyBusinessOpportunity(
  organisationId: string,
  opportunityId: string,
  budget?: VerificationBudget,
): Promise<VerifyBusinessOpportunityResult> {
  const opportunity = await prisma.businessOpportunity.findFirst({
    where: { id: opportunityId, organisationId },
  });
  if (!opportunity) {
    throw new Error("BusinessOpportunity not found in organisation");
  }

  const resolvedBudget = budget ?? opportunity.verificationBudget ?? "STANDARD";
  const findings = await loadFindingsForOpportunity(organisationId, opportunityId);
  const relevance = await loadRelevanceContext(organisationId);

  const pipeline = runVerificationPipeline({
    findings,
    budget: resolvedBudget,
    relevance,
    consequenceLevel:
      opportunity.impact === "VERY_HIGH" || opportunity.impact === "HIGH" ? "HIGH" : "MEDIUM",
  });

  const result = await prisma.$transaction(async (tx) => {
    const claimIds: string[] = [];

    for (const claim of pipeline.claims) {
      const dims = claim.dimensions;
      const row = await tx.intelligenceClaim.upsert({
        where: {
          organisationId_normalisedKey: {
            organisationId,
            normalisedKey: claim.normalisedKey,
          },
        },
        create: {
          organisationId,
          researchJobId: claim.evidence.find((e) => e.researchFindingId)
            ? findings.find((f) => f.researchFindingId === claim.evidence[0]?.researchFindingId)
                ?.researchJobId
            : undefined,
          text: claim.text,
          normalisedKey: claim.normalisedKey,
          claimKind: claim.claimKind,
          status: claim.status as IntelligenceClaimStatus,
          authorityScore: dims.authority,
          freshnessScore: dims.freshness,
          corroborationScore: dims.corroboration,
          independenceScore: dims.independence,
          audienceRelevanceScore: dims.audienceRelevance,
          platformRelevanceScore: dims.platformRelevance,
          geoRelevanceScore: dims.geoRelevance,
          sampleSizeScore: dims.sampleSize,
          socialQualityScore: dims.socialQuality,
          survivorshipRisk: dims.survivorshipRisk,
          negativeEvidenceScore: dims.negativeEvidence,
          dimensions: dims as unknown as Prisma.InputJsonValue,
        },
        update: {
          text: claim.text,
          status: claim.status as IntelligenceClaimStatus,
          authorityScore: dims.authority,
          freshnessScore: dims.freshness,
          corroborationScore: dims.corroboration,
          independenceScore: dims.independence,
          audienceRelevanceScore: dims.audienceRelevance,
          platformRelevanceScore: dims.platformRelevance,
          geoRelevanceScore: dims.geoRelevance,
          sampleSizeScore: dims.sampleSize,
          socialQualityScore: dims.socialQuality,
          survivorshipRisk: dims.survivorshipRisk,
          negativeEvidenceScore: dims.negativeEvidence,
          dimensions: dims as unknown as Prisma.InputJsonValue,
        },
      });
      claimIds.push(row.id);

      for (const ev of claim.evidence) {
        await tx.claimEvidenceLink.create({
          data: {
            organisationId,
            claimId: row.id,
            researchSourceId: ev.researchSourceId ?? undefined,
            researchSnapshotId: ev.researchSnapshotId ?? undefined,
            researchFindingId: ev.researchFindingId ?? undefined,
            providerKey: ev.providerKey ?? undefined,
            sourceUrl: ev.sourceUrl ?? undefined,
            retrievedAt: ev.retrievedAt ?? undefined,
            lineageKey: ev.lineage,
            supports: ev.supports,
            excerpt: ev.excerpt ?? undefined,
          },
        });
      }
    }

    const assessment = await tx.qualityAssessment.create({
      data: {
        organisationId,
        subjectKind: "BusinessOpportunity",
        subjectId: opportunityId,
        budget: resolvedBudget,
        gateStatus: pipeline.gateStatus,
        dimensions: pipeline.dimensions as unknown as Prisma.InputJsonValue,
        criticNotes: pipeline.criticNotes,
        escalationReason: pipeline.escalationReason,
        consequenceLevel: pipeline.consequenceLevel,
        assessedAt: new Date(),
        claims: {
          create: claimIds.map((claimId, i) => ({
            claimId,
            role: i === 0 ? "PRIMARY" : "SUPPORTING",
          })),
        },
      },
    });

    const nextConfidence = confidenceAfterGate(pipeline.gateStatus, opportunity.confidence);
    const { score, factors } = computePriorityScore({
      impact: opportunity.impact,
      urgency: opportunity.urgency,
      confidence: nextConfidence,
      goalAlignment:
        typeof (opportunity.scoreFactors as Record<string, unknown>)?.goalAlignment === "number"
          ? ((opportunity.scoreFactors as Record<string, number>).goalAlignment as number)
          : undefined,
      effortFactor:
        typeof (opportunity.scoreFactors as Record<string, unknown>)?.effortFactor === "number"
          ? ((opportunity.scoreFactors as Record<string, number>).effortFactor as number)
          : undefined,
    });

    // Never leave a failed gate looking like a high-priority PASSED opportunity.
    const priorityScore = gateAllowsHighPriorityOpportunity(pipeline.gateStatus)
      ? score
      : Math.min(score, 2);

    await tx.businessOpportunity.update({
      where: { id: opportunityId },
      data: {
        qualityGateStatus: pipeline.gateStatus,
        qualityAssessmentId: assessment.id,
        verificationBudget: resolvedBudget,
        confidence: nextConfidence,
        priorityScore,
        scoreFactors: {
          ...(typeof opportunity.scoreFactors === "object" && opportunity.scoreFactors
            ? (opportunity.scoreFactors as Record<string, unknown>)
            : {}),
          ...factors,
          qualityGateStatus: pipeline.gateStatus,
          qualityAssessmentId: assessment.id,
        } as Prisma.InputJsonValue,
      },
    });

    await appendDomainEvent(tx, {
      organisationId,
      eventType: "QUALITY_ASSESSMENT_COMPLETED",
      aggregateType: "QualityAssessment",
      aggregateId: assessment.id,
      payload: {
        assessmentId: assessment.id,
        subjectKind: "BusinessOpportunity",
        subjectId: opportunityId,
        gateStatus: pipeline.gateStatus,
      },
      dedupeKey: `quality-assessment:${assessment.id}`,
    });

    return assessment;
  });

  return {
    assessment: result,
    pipeline,
    opportunityId,
    gateStatus: pipeline.gateStatus,
  };
}

/**
 * Light post-detect hook — only verifies when research findings are attached.
 * Does not invent evidence for CRM-only detectors.
 */
export async function maybeVerifyOpportunityAfterDetect(input: {
  organisationId: string;
  opportunityId: string;
  evidences: Array<{ evidenceType: string; evidenceId?: string | null }>;
  budget?: VerificationBudget;
}): Promise<VerifyBusinessOpportunityResult | null> {
  const hasResearch = input.evidences.some(
    (e) => RESEARCH_EVIDENCE_TYPES.has(e.evidenceType) && e.evidenceId,
  );
  if (!hasResearch) return null;
  try {
    return await verifyBusinessOpportunity(
      input.organisationId,
      input.opportunityId,
      input.budget,
    );
  } catch (error) {
    logger.warn("Post-detect quality verification failed", {
      organisationId: input.organisationId,
      opportunityId: input.opportunityId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}
