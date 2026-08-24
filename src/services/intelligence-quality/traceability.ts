/**
 * Phase 14F — Recommendation → Opportunity → Claim → Evidence → Snapshot → Provider → retrievalTime
 * Traceability chain for UI / API consumers.
 */

import { prisma } from "@/lib/db";

export type TraceabilityLink = {
  kind:
    | "Recommendation"
    | "Opportunity"
    | "Claim"
    | "Evidence"
    | "Snapshot"
    | "Provider"
    | "RetrievalTime";
  id: string | null;
  label: string;
  meta?: Record<string, unknown>;
};

export type OpportunityTraceabilityChain = {
  opportunityId: string;
  organisationId: string;
  qualityAssessmentId: string | null;
  gateStatus: string;
  chains: TraceabilityLink[][];
};

/**
 * Build per-claim provenance chains for an opportunity's latest quality assessment.
 */
export async function buildOpportunityTraceability(
  organisationId: string,
  opportunityId: string,
): Promise<OpportunityTraceabilityChain | null> {
  const opportunity = await prisma.businessOpportunity.findFirst({
    where: { id: opportunityId, organisationId },
    include: {
      qualityAssessment: {
        include: {
          claims: {
            include: {
              claim: {
                include: {
                  evidenceLinks: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!opportunity) return null;

  const assessment = opportunity.qualityAssessment;
  const chains: TraceabilityLink[][] = [];

  const recommendationHead: TraceabilityLink = {
    kind: "Recommendation",
    id: opportunity.id,
    label: opportunity.title,
    meta: { type: opportunity.type, source: opportunity.source },
  };
  const opportunityLink: TraceabilityLink = {
    kind: "Opportunity",
    id: opportunity.id,
    label: opportunity.title,
    meta: {
      status: opportunity.status,
      qualityGateStatus: opportunity.qualityGateStatus,
      priorityScore: opportunity.priorityScore,
    },
  };

  if (!assessment || assessment.claims.length === 0) {
    chains.push([recommendationHead, opportunityLink]);
    return {
      opportunityId,
      organisationId,
      qualityAssessmentId: assessment?.id ?? opportunity.qualityAssessmentId,
      gateStatus: opportunity.qualityGateStatus,
      chains,
    };
  }

  for (const link of assessment.claims) {
    const claim = link.claim;
    const claimLink: TraceabilityLink = {
      kind: "Claim",
      id: claim.id,
      label: claim.text.slice(0, 240),
      meta: {
        status: claim.status,
        normalisedKey: claim.normalisedKey,
        role: link.role,
      },
    };

    if (claim.evidenceLinks.length === 0) {
      chains.push([recommendationHead, opportunityLink, claimLink]);
      continue;
    }

    for (const ev of claim.evidenceLinks) {
      const evidenceLink: TraceabilityLink = {
        kind: "Evidence",
        id: ev.id,
        label: ev.excerpt?.slice(0, 200) ?? ev.sourceUrl ?? ev.lineageKey ?? "evidence",
        meta: {
          researchFindingId: ev.researchFindingId,
          researchSourceId: ev.researchSourceId,
          supports: ev.supports,
          lineageKey: ev.lineageKey,
        },
      };
      const snapshotLink: TraceabilityLink = {
        kind: "Snapshot",
        id: ev.researchSnapshotId,
        label: ev.researchSnapshotId
          ? `snapshot:${ev.researchSnapshotId}`
          : "no-snapshot",
        meta: { researchSourceId: ev.researchSourceId },
      };
      const providerLink: TraceabilityLink = {
        kind: "Provider",
        id: ev.providerKey,
        label: ev.providerKey ?? "unknown-provider",
        meta: { sourceUrl: ev.sourceUrl },
      };
      const retrievalLink: TraceabilityLink = {
        kind: "RetrievalTime",
        id: ev.retrievedAt?.toISOString() ?? null,
        label: ev.retrievedAt?.toISOString() ?? "unknown-retrieval-time",
        meta: { retrievedAt: ev.retrievedAt?.toISOString() ?? null },
      };
      chains.push([
        recommendationHead,
        opportunityLink,
        claimLink,
        evidenceLink,
        snapshotLink,
        providerLink,
        retrievalLink,
      ]);
    }
  }

  return {
    opportunityId,
    organisationId,
    qualityAssessmentId: assessment.id,
    gateStatus: opportunity.qualityGateStatus,
    chains,
  };
}
