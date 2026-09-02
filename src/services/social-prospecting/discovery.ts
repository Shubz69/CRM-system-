import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { planCompute } from "@/services/compute-governor";
import { gatherProspectCandidatesFromResearch } from "@/services/social-prospecting/research-bridge";
import { dedupeProspectBatch } from "@/services/social-prospecting/quality";
import {
  buildProspectDedupeKey,
  mergeDiscoveryCostLimits,
  parseProspectIntent,
  type DiscoveryCostLimits,
  type SocialProspectCandidateInput,
  type StructuredIcp,
} from "@/services/social-prospecting/types";
import type { SocialProspect } from "@prisma/client";
import { recordSocialProviderUsage } from "@/services/social-prospecting/usage";

export type DiscoveryResult = {
  icp: StructuredIcp;
  computeMode: string;
  candidates: SocialProspect[];
  rejectedCount: number;
  liveResearch: boolean;
  externalCalls: number;
  billableCents: number;
  tiersTried: string[];
  sourcesConfigured: string[];
  degraded: boolean;
  degradationNotes: string[];
  sourceErrors: Array<{ platform: string; message: string; code: string }>;
};

/**
 * Live-capable social prospect discovery.
 * Invokes existing research/source adapters unless `seedCandidates` are provided (tests/fixtures only).
 * Does NOT use LinkedIn Marketing API member data as a prospect database.
 * Does NOT depend on Ayrshare.
 */
export async function discoverSocialProspects(input: {
  organisationId: string;
  query: string;
  /** Test/demo fixtures only — when omitted, live research runs. */
  seedCandidates?: SocialProspectCandidateInput[];
  /** When true, skip live research even if seeds empty (tests). */
  skipLiveResearch?: boolean;
  costLimits?: Partial<DiscoveryCostLimits>;
}): Promise<DiscoveryResult> {
  const icp = parseProspectIntent(input.query);
  const limits = mergeDiscoveryCostLimits(icp.desiredCount, input.costLimits);

  const plan = await planCompute({
    taskType: "insight_generation",
    complexity: limits.maxCandidates > 8 ? "HIGH" : "MEDIUM",
    consequence: "MEDIUM",
    organisationId: input.organisationId,
    verificationBudget: limits.maxResearchDepth,
  });

  let working: SocialProspectCandidateInput[] = input.seedCandidates ? [...input.seedCandidates] : [];
  let liveResearch = false;
  let externalCalls = 0;
  let billableCents = 0;
  let tiersTried: string[] = [];
  let sourcesConfigured: string[] = [];
  let degraded = false;
  let degradationNotes: string[] = [];
  let sourceErrors: DiscoveryResult["sourceErrors"] = [];

  const needLive =
    !input.skipLiveResearch &&
    (!input.seedCandidates || input.seedCandidates.length === 0);

  if (needLive) {
    liveResearch = true;
    const depth =
      plan.executionMode === "ECONOMY" || plan.executionMode === "CACHE"
        ? "FAST"
        : plan.executionMode === "DEEP" || plan.executionMode === "ADVANCED"
          ? "DEEP"
          : limits.maxResearchDepth;

    const bridge = await gatherProspectCandidatesFromResearch({
      organisationId: input.organisationId,
      icp,
      limits: { ...limits, maxResearchDepth: depth },
    });
    working = bridge.candidates;
    externalCalls = bridge.externalCalls;
    billableCents = bridge.billableCents;
    tiersTried = bridge.tiersTried;
    sourcesConfigured = bridge.sourcesConfigured;
    degraded = bridge.degraded;
    degradationNotes = bridge.degradationNotes;
    sourceErrors = bridge.sourceErrors;

    await recordSocialProviderUsage({
      organisationId: input.organisationId,
      provider: "RESEARCH_SOURCES",
      capability: "DISCOVERY",
      requestCount: externalCalls || 1,
      costCents: billableCents || null,
      metadata: {
        tiersTried,
        degraded,
        query: icp.rawQuery.slice(0, 200),
      },
    }).catch(() => undefined);
  } else if (input.seedCandidates?.length) {
    tiersTried = ["seed_fixtures"];
    // Still resolve identities for fixtures — never invent URLs
    const { resolveIdentitiesForCandidate, applyIdentitiesToCandidate } = await import(
      "@/services/social-prospecting/identity-resolver"
    );
    working = working.map((c) => {
      const identities = resolveIdentitiesForCandidate({
        personName: c.personName,
        companyName: c.companyName,
        role: c.role,
        location: c.location,
        sourceResults: [],
        extraUrls: [c.linkedinUrl, c.instagramUrl, ...(c.otherSocialUrls || [])].filter(Boolean) as string[],
      });
      return applyIdentitiesToCandidate(c, identities);
    });
  }

  const quality = dedupeProspectBatch(working).slice(0, limits.maxCandidates);
  const rejectedCount = Math.max(0, working.length - quality.length);

  const saved: SocialProspect[] = [];
  for (const q of quality) {
    const dedupeKey = buildProspectDedupeKey(q.candidate);
    const row = await prisma.socialProspect.upsert({
      where: {
        organisationId_dedupeKey: {
          organisationId: input.organisationId,
          dedupeKey,
        },
      },
      create: {
        organisationId: input.organisationId,
        status: "DISCOVERED",
        personName: q.candidate.personName,
        companyName: q.candidate.companyName,
        role: q.candidate.role,
        companyWebsite: q.candidate.companyWebsite,
        location: q.candidate.location,
        linkedinUrl: q.candidate.linkedinUrl,
        instagramUrl: q.candidate.instagramUrl,
        otherSocialUrls: (q.candidate.otherSocialUrls || []) as Prisma.InputJsonValue,
        socialIdentities: (q.candidate.socialIdentities || []) as Prisma.InputJsonValue,
        sourceEvidence: q.candidate.sourceEvidence as Prisma.InputJsonValue,
        sourceQuality: q.candidate.sourceQuality,
        confidence: q.confidence,
        fitScore: q.fitScore,
        reasonSelected: q.reasonSelected,
        uncertaintyFlags: q.uncertaintyFlags as Prisma.InputJsonValue,
        preferredNetworks: icp.preferredNetworks as Prisma.InputJsonValue,
        icpSnapshot: icp as unknown as Prisma.InputJsonValue,
        dedupeKey,
      },
      update: {
        confidence: q.confidence,
        fitScore: q.fitScore,
        reasonSelected: q.reasonSelected,
        uncertaintyFlags: q.uncertaintyFlags as Prisma.InputJsonValue,
        sourceEvidence: q.candidate.sourceEvidence as Prisma.InputJsonValue,
        socialIdentities: (q.candidate.socialIdentities || []) as Prisma.InputJsonValue,
        linkedinUrl: q.candidate.linkedinUrl,
        instagramUrl: q.candidate.instagramUrl,
        otherSocialUrls: (q.candidate.otherSocialUrls || []) as Prisma.InputJsonValue,
        status: "RESEARCHED",
      },
    });
    saved.push(row);
  }

  return {
    icp,
    computeMode: plan.executionMode,
    candidates: saved,
    rejectedCount,
    liveResearch,
    externalCalls,
    billableCents,
    tiersTried,
    sourcesConfigured,
    degraded,
    degradationNotes,
    sourceErrors,
  };
}

export async function listSocialProspects(organisationId: string, take = 50) {
  return prisma.socialProspect.findMany({
    where: { organisationId },
    orderBy: [{ fitScore: "desc" }, { retrievedAt: "desc" }],
    take,
  });
}

export async function getSocialProspectForOrg(organisationId: string, id: string) {
  return prisma.socialProspect.findFirst({ where: { id, organisationId } });
}
