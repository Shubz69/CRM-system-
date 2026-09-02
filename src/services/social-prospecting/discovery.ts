import { randomUUID } from "crypto";
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

export type DiscoveryRejection = {
  personName?: string;
  companyName?: string;
  code: string;
  reason: string;
};

export type DiscoveryResult = {
  icp: StructuredIcp;
  computeMode: string;
  /** Distinct run id for this discovery (stored as researchJobId) */
  searchRunId: string;
  candidates: SocialProspect[];
  rejectedCount: number;
  rejectedSample: DiscoveryRejection[];
  requestedCount: number;
  returnedCount: number;
  qualityNote?: string;
  liveResearch: boolean;
  externalCalls: number;
  billableCents: number;
  tiersTried: string[];
  sourcesConfigured: string[];
  degraded: boolean;
  degradationNotes: string[];
  sourceErrors: Array<{ platform: string; message: string; code: string }>;
};

function newSearchRunId(): string {
  return `run_${randomUUID()}`;
}

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
  const searchRunId = newSearchRunId();

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
    !input.skipLiveResearch && (!input.seedCandidates || input.seedCandidates.length === 0);

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
        searchRunId,
      },
    }).catch(() => undefined);
  } else if (input.seedCandidates?.length) {
    tiersTried = ["seed_fixtures"];
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
        extraUrls: [c.linkedinUrl, c.instagramUrl, ...(c.otherSocialUrls || [])].filter(
          Boolean,
        ) as string[],
      });
      return applyIdentitiesToCandidate(c, identities);
    });
  }

  const { accepted, rejected } = dedupeProspectBatch(working, icp);
  // Prefer fewer excellent results — never pad with garbage to hit desiredCount
  const quality = accepted.slice(0, limits.maxCandidates);
  const rejectedCount = rejected.length + Math.max(0, accepted.length - quality.length);
  const rejectedSample: DiscoveryRejection[] = rejected.slice(0, 12).map((r) => ({
    personName: r.candidate.personName,
    companyName: r.candidate.companyName,
    code: r.rejectionCode || "REJECTED",
    reason: r.reasonSelected,
  }));

  const saved: SocialProspect[] = [];
  for (const q of quality) {
    const dedupeKey = buildProspectDedupeKey(q.candidate);
    const uncertainty = [
      ...(q.uncertaintyFlags || []),
      ...(q.candidate.qaDecision
        ? [`qa:${JSON.stringify(q.candidate.qaDecision).slice(0, 400)}`]
        : []),
    ];
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
        uncertaintyFlags: uncertainty as Prisma.InputJsonValue,
        preferredNetworks: icp.preferredNetworks as Prisma.InputJsonValue,
        icpSnapshot: { ...icp, searchRunId } as unknown as Prisma.InputJsonValue,
        researchJobId: searchRunId,
        dedupeKey,
      },
      update: {
        confidence: q.confidence,
        fitScore: q.fitScore,
        reasonSelected: q.reasonSelected,
        uncertaintyFlags: uncertainty as Prisma.InputJsonValue,
        sourceEvidence: q.candidate.sourceEvidence as Prisma.InputJsonValue,
        socialIdentities: (q.candidate.socialIdentities || []) as Prisma.InputJsonValue,
        linkedinUrl: q.candidate.linkedinUrl,
        instagramUrl: q.candidate.instagramUrl,
        otherSocialUrls: (q.candidate.otherSocialUrls || []) as Prisma.InputJsonValue,
        personName: q.candidate.personName,
        companyName: q.candidate.companyName,
        role: q.candidate.role,
        location: q.candidate.location,
        researchJobId: searchRunId,
        icpSnapshot: { ...icp, searchRunId } as unknown as Prisma.InputJsonValue,
        status: "RESEARCHED",
      },
    });
    saved.push(row);
  }

  const requestedCount = icp.desiredCount;
  const returnedCount = saved.length;
  const qualityNote =
    returnedCount < requestedCount
      ? `Only ${returnedCount} sufficiently verified match${returnedCount === 1 ? "" : "es"} found for this search.`
      : undefined;

  return {
    icp,
    computeMode: plan.executionMode,
    searchRunId,
    candidates: saved,
    rejectedCount,
    rejectedSample,
    requestedCount,
    returnedCount,
    qualityNote,
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

export async function listSocialProspects(
  organisationId: string,
  opts?: { take?: number; searchRunId?: string | null },
) {
  const take = opts?.take ?? 50;
  return prisma.socialProspect.findMany({
    where: {
      organisationId,
      ...(opts?.searchRunId ? { researchJobId: opts.searchRunId } : {}),
    },
    orderBy: [{ fitScore: "desc" }, { retrievedAt: "desc" }],
    take,
  });
}

export async function listRecentSearchRuns(organisationId: string, take = 8) {
  const rows = await prisma.socialProspect.findMany({
    where: { organisationId, researchJobId: { not: null } },
    orderBy: { retrievedAt: "desc" },
    take: 80,
    select: { researchJobId: true, retrievedAt: true, icpSnapshot: true },
  });
  const seen = new Set<string>();
  const runs: Array<{ searchRunId: string; retrievedAt: string; query?: string }> = [];
  for (const r of rows) {
    const id = r.researchJobId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const snap = r.icpSnapshot as { rawQuery?: string } | null;
    runs.push({
      searchRunId: id,
      retrievedAt: r.retrievedAt.toISOString(),
      query: snap?.rawQuery,
    });
    if (runs.length >= take) break;
  }
  return runs;
}

export async function getSocialProspectForOrg(organisationId: string, id: string) {
  return prisma.socialProspect.findFirst({
    where: { id, organisationId },
  });
}
