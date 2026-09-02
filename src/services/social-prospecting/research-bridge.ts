/**
 * Live research bridge for social prospecting.
 * Uses existing Agent Desk source adapters — NOT Ayrshare, NOT LinkedIn Marketing API.
 */

import {
  collectCheapestSufficientSources,
  listConfiguredSourcePlatforms,
  searchConfiguredSources,
  SourceNotConfiguredError,
  type SourcePlatform,
  type SourceResult,
} from "@/adapters/sources";
import { prisma } from "@/lib/db";
import {
  applyIdentitiesToCandidate,
  resolveIdentitiesForCandidate,
} from "@/services/social-prospecting/identity-resolver";
import {
  buildResearchQueries,
  mergeDiscoveryCostLimits,
  type DiscoveryCostLimits,
  type SocialProspectCandidateInput,
  type StructuredIcp,
} from "@/services/social-prospecting/types";

export type ResearchBridgeResult = {
  candidates: SocialProspectCandidateInput[];
  sourceErrors: Array<{ platform: string; message: string; code: string }>;
  externalCalls: number;
  billableCents: number;
  tiersTried: string[];
  sourcesConfigured: SourcePlatform[];
  degraded: boolean;
  degradationNotes: string[];
};

function guessPersonName(text: string): string | undefined {
  const m = text.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b(?:\s+(?:is|was|,|–|-)\s+(?:the\s+)?(?:founder|CEO|owner|director|creator))?/,
  );
  return m?.[1];
}

function guessCompany(text: string, icp?: StructuredIcp): string | undefined {
  const m = text.match(
    /\b(?:at|of|@)\s+([A-Z][A-Za-z0-9&'.\-\s]{2,40}?)(?:\s+(?:Ltd|Limited|Inc|LLC|LLP|PLC)\b|[.,]|$)/,
  );
  if (m?.[1]) return m[1].trim();
  if (icp?.industry && text.toLowerCase().includes(icp.industry)) {
    const co = text.match(new RegExp(`([A-Z][A-Za-z0-9&'.\\-\\s]{2,30})\\s+${icp.industry}`, "i"));
    if (co?.[1]) return co[1].trim();
  }
  return undefined;
}

function resultToCandidate(r: SourceResult, icp: StructuredIcp): SocialProspectCandidateInput | null {
  const blob = `${r.title}\n${r.content}\n${r.author || ""}`;

  // Reject privacy/legal/listicle pages early
  if (/privacy|terms of|cookie policy|instagram\.com\/(about|legal)/i.test(`${r.url} ${r.title}`)) {
    return null;
  }
  if (/linkedin\.com\/company\//i.test(r.url) && icp.entityType !== "company") {
    return null;
  }

  const personName = r.author?.trim() || guessPersonName(blob);
  const companyName = guessCompany(blob, icp);
  if (!personName && !companyName) return null;

  // Extract role/location from evidence — never stamp ICP onto every candidate
  const roleFromEvidence = blob.match(
    /\b((?:co[- ]?)?founder(?:\s*[&/]\s*ceo)?|ceo|owner|director|creator|dentist|influencer)s?\b/i,
  )?.[1];
  const locFromEvidence = blob.match(
    /\b(london|manchester|birmingham|edinburgh|glasgow|uk|united kingdom|england|scotland|wales)\b/i,
  )?.[1];

  if (/^https?:\/\/(www\.)?(bbc|reuters|wikipedia|gov\.uk)\./i.test(r.url) && !personName) {
    return null;
  }

  const base: SocialProspectCandidateInput = {
    personName,
    companyName,
    role: roleFromEvidence,
    location: locFromEvidence,
    companyWebsite:
      /^https?:\/\//i.test(r.url) && !/linkedin|instagram|tiktok|twitter|x\.com|threads/i.test(r.url)
        ? r.url.split("?")[0]
        : undefined,
    sourceEvidence: [
      {
        source: r.platform,
        url: r.url,
        excerpt: (r.content || r.title).slice(0, 320),
        retrievedAt: new Date().toISOString(),
      },
    ],
    sourceQuality: r.platform === "web" ? "web_search" : r.platform,
    preferredNetworks: icp.preferredNetworks,
    retrievedAt: new Date().toISOString(),
  };

  const identities = resolveIdentitiesForCandidate({
    personName,
    companyName,
    role: roleFromEvidence,
    location: locFromEvidence,
    sourceResults: [r],
  });

  return applyIdentitiesToCandidate(base, identities);
}

async function loadCrmKnowledgeSeeds(
  organisationId: string,
  icp: StructuredIcp,
  limit: number,
): Promise<SocialProspectCandidateInput[]> {
  const keyword = icp.industry || icp.keywords[0];
  if (!keyword) return [];
  const contacts = await prisma.contact.findMany({
    where: {
      organisationId,
      deletedAt: null,
      OR: [
        { fullName: { contains: keyword, mode: "insensitive" } },
        { location: icp.location ? { contains: icp.location, mode: "insensitive" } : undefined },
        { leadSource: { contains: "social", mode: "insensitive" } },
      ].filter(Boolean) as object[],
    },
    take: limit,
    include: { company: true, identifiers: true },
  });

  return contacts.map((c) => {
    const linkedin = c.identifiers.find((i) => i.channel === "linkedin_url")?.identifier;
    const base: SocialProspectCandidateInput = {
      personName: c.fullName || undefined,
      companyName: c.company?.name,
      location: c.location || undefined,
      companyWebsite: c.company?.website || undefined,
      linkedinUrl: linkedin,
      instagramUrl: c.instagramUsername ? `https://www.instagram.com/${c.instagramUsername}` : undefined,
      sourceEvidence: [
        {
          source: "crm",
          excerpt: `Existing CRM contact${c.company?.name ? ` at ${c.company.name}` : ""}`,
          retrievedAt: new Date().toISOString(),
        },
      ],
      sourceQuality: "first_party_crm",
      preferredNetworks: icp.preferredNetworks,
    };
    const identities = resolveIdentitiesForCandidate({
      personName: base.personName,
      companyName: base.companyName,
      location: base.location,
      sourceResults: [],
      extraUrls: [linkedin, base.instagramUrl].filter(Boolean) as string[],
    });
    return applyIdentitiesToCandidate(base, identities);
  });
}

/**
 * Progressive live research for prospect discovery with hard cost caps.
 */
export async function gatherProspectCandidatesFromResearch(input: {
  organisationId: string;
  icp: StructuredIcp;
  limits?: Partial<DiscoveryCostLimits>;
}): Promise<ResearchBridgeResult> {
  const limits = mergeDiscoveryCostLimits(input.icp.desiredCount, input.limits);
  const configured = listConfiguredSourcePlatforms();
  const degradationNotes: string[] = [];
  if (!configured.includes("web")) {
    degradationNotes.push("Web/Tavily search not configured — results limited");
  }
  if (!configured.some((p) => ["instagram", "linkedin", "tiktok", "twitter", "threads"].includes(p))) {
    degradationNotes.push("Apify social sources not configured — profile discovery limited to web evidence");
  }

  const queries = buildResearchQueries(input.icp);
  // Instagram creator searches: prioritize Instagram-targeted queries and Apify IG tier
  const wantsInstagram = input.icp.preferredNetworks.includes("instagram");
  const orderedQueries = wantsInstagram
    ? [
        ...queries.filter((q) => /instagram/i.test(q)),
        ...queries.filter((q) => !/instagram/i.test(q)),
      ]
    : queries;
  let externalCalls = 0;
  let billableCents = 0;
  const allResults: SourceResult[] = [];
  const sourceErrors: ResearchBridgeResult["sourceErrors"] = [];
  const tiersTried: string[] = [];

  const cheapCrm = await loadCrmKnowledgeSeeds(input.organisationId, input.icp, Math.min(5, limits.maxCandidates));

  const progressive = await collectCheapestSufficientSources({
    minItems: Math.min(3, limits.maxCandidates),
    tiers: [
      {
        tier: "business_profile_knowledge_crm",
        enabled: true,
        fetch: async () => {
          tiersTried.push("business_profile_knowledge_crm");
          return { items: cheapCrm, notes: ["crm_seeds"] };
        },
      },
      {
        tier: "tavily_http",
        enabled: configured.includes("web"),
        fetch: async () => {
          tiersTried.push("tavily_http");
          const items: SourceResult[] = [];
          for (const q of orderedQueries.slice(0, wantsInstagram ? 4 : 2)) {
            if (externalCalls >= limits.maxExternalCalls) break;
            if (billableCents >= limits.maxEstimatedCostCents) break;
            externalCalls += 1;
            try {
              const res = await searchConfiguredSources({
                query: q,
                platforms: ["web"],
                options: {
                  organisationId: input.organisationId,
                  limit: Math.min(5, limits.maxSources),
                  qualityBudget: limits.maxResearchDepth,
                  governorMode: limits.maxResearchDepth === "FAST" ? "ECONOMY" : "STANDARD",
                },
              });
              billableCents += res.billableCents;
              sourceErrors.push(...res.errors);
              items.push(...res.results);
              allResults.push(...res.results);
            } catch (error) {
              const message = error instanceof Error ? error.message : "web search failed";
              sourceErrors.push({
                platform: "web",
                message,
                code: error instanceof SourceNotConfiguredError ? "NOT_CONFIGURED" : "SEARCH_FAILED",
              });
              degradationNotes.push("Web search unavailable — continuing with other tiers");
            }
          }
          return { items, notes: ["web_search"] };
        },
      },
      {
        tier: "apify_approved_low_cost",
        enabled: configured.some((p) =>
          ["instagram", "linkedin", "tiktok", "twitter", "threads"].includes(p),
        ),
        fetch: async () => {
          tiersTried.push("apify_approved_low_cost");
          if (externalCalls >= limits.maxExternalCalls || billableCents >= limits.maxEstimatedCostCents) {
            return { items: [], notes: ["external_call_or_cost_cap"] };
          }
          const platforms: SourcePlatform[] = [];
          if (input.icp.preferredNetworks.includes("instagram") && configured.includes("instagram")) {
            platforms.push("instagram");
          }
          if (
            (input.icp.preferredNetworks.includes("linkedin") ||
              input.icp.preferredNetworks.includes("any")) &&
            configured.includes("linkedin")
          ) {
            // Public LinkedIn *content* via approved Apify listen — not Marketing API member search
            platforms.push("linkedin");
          }
          if (input.icp.preferredNetworks.includes("tiktok") && configured.includes("tiktok")) {
            platforms.push("tiktok");
          }
          if (input.icp.preferredNetworks.includes("x") && configured.includes("twitter")) {
            platforms.push("twitter");
          }
          if (!platforms.length) {
            return { items: [], notes: ["no_matching_apify_platform"] };
          }
          externalCalls += 1;
          try {
            const res = await searchConfiguredSources({
              query: wantsInstagram
                ? orderedQueries.find((q) => /instagram/i.test(q)) || queries[0]!
                : queries[0]!,
              platforms,
              options: {
                organisationId: input.organisationId,
                limit: Math.min(5, limits.maxSources),
                qualityBudget: limits.maxResearchDepth,
                governorMode: "STANDARD",
              },
            });
            billableCents += res.billableCents;
            sourceErrors.push(...res.errors);
            allResults.push(...res.results);
            return { items: res.results, notes: ["apify_social"] };
          } catch (error) {
            const message = error instanceof Error ? error.message : "apify search failed";
            sourceErrors.push({
              platform: platforms[0] || "linkedin",
              message,
              code: error instanceof SourceNotConfiguredError ? "NOT_CONFIGURED" : "SEARCH_FAILED",
            });
            degradationNotes.push("Apify social sources unavailable — continuing without paid social scrape");
            return { items: [], notes: ["apify_failed"] };
          }
        },
      },
    ],
    isSufficient: (evidence) => {
      if (billableCents >= limits.maxEstimatedCostCents) return true;
      return evidence.items.length >= Math.min(limits.maxCandidates, 5);
    },
  });

  // Map progressive evidence + allResults into candidates
  const mapped: SocialProspectCandidateInput[] = [];
  for (const item of progressive.evidence.items) {
    if (item && typeof item === "object" && "sourceEvidence" in (item as object)) {
      mapped.push(item as SocialProspectCandidateInput);
      continue;
    }
    if (item && typeof item === "object" && "platform" in (item as object) && "url" in (item as object)) {
      const c = resultToCandidate(item as SourceResult, input.icp);
      if (c) mapped.push(c);
    }
  }
  for (const r of allResults) {
    const c = resultToCandidate(r, input.icp);
    if (c) mapped.push(c);
  }

  // Second-pass identity resolution across pooled evidence for same names
  const enriched = mapped.map((c) => {
    const related = allResults.filter((r) => {
      const blob = `${r.title} ${r.content} ${r.author || ""}`.toLowerCase();
      const person = c.personName?.toLowerCase().split(" ")[0];
      return person ? blob.includes(person) : true;
    });
    const identities = resolveIdentitiesForCandidate({
      personName: c.personName,
      companyName: c.companyName,
      role: c.role,
      location: c.location,
      sourceResults: related.length ? related : allResults.slice(0, 5),
      extraUrls: [c.linkedinUrl, c.instagramUrl, ...(c.otherSocialUrls || [])].filter(Boolean) as string[],
    });
    return applyIdentitiesToCandidate(c, identities);
  });

  const degraded = degradationNotes.length > 0 || (!configured.length && enriched.length === 0);

  return {
    candidates: enriched.slice(0, limits.maxCandidates * 3), // quality layer trims further
    sourceErrors,
    externalCalls,
    billableCents,
    tiersTried: [...new Set([...tiersTried, ...progressive.tiersTried])],
    sourcesConfigured: configured,
    degraded,
    degradationNotes,
  };
}
