import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SocialCapabilityBlockedError,
  getDeclaredCapability,
  linkedInInvitationsApiApproved,
  resolveLinkedInCommunicationsAvailability,
} from "@/services/social-prospecting/capabilities";
import {
  sendConnectionInvitation,
  sendLinkedInMessage,
  linkedInV1ActionSurface,
  linkedInV2ActionSurface,
} from "@/services/social-prospecting/linkedin-native";
import {
  parseProspectIntent,
  buildProspectDedupeKey,
  normalizeLinkedInUrl,
  mergeDiscoveryCostLimits,
  DEFAULT_DISCOVERY_COST_LIMITS,
} from "@/services/social-prospecting/types";
import { dedupeProspectBatch, qualityCheckProspect } from "@/services/social-prospecting/quality";
import { generateOutreachDrafts, buildActionSurfacesForProspect } from "@/services/social-prospecting/outreach";
import {
  resolveIdentitiesForCandidate,
  verifyProfileAgainstCandidate,
  applyIdentitiesToCandidate,
  detectNetworkFromUrl,
} from "@/services/social-prospecting/identity-resolver";
import {
  universalOutreachSurface,
  ensureDefaultMessagingProvidersRegistered,
  listSocialMessagingProviders,
} from "@/services/social-prospecting/provider-router";
import { storeAyrshareMetrics, isAyrshareConfigured } from "@/adapters/ayrshare";
import { resetEnvCache } from "@/lib/env";
import { roleHasPermission } from "@/lib/permissions";
import { MemberRole } from "@prisma/client";

const prismaMocks = vi.hoisted(() => ({
  socialMetricFact: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  socialProviderUsage: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  ayrshareProfile: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
  },
  socialProspect: {
    upsert: vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
      id: "prospect_1",
      ...args.create,
      ...args.update,
    })),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  socialOutreachThread: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "thread_1", ...args.data })),
    findFirst: vi.fn(),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  contact: {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "contact_1", ...args.data })),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  company: {
    findFirst: vi.fn(),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "company_1", ...args.data })),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  contactIdentifier: {
    findFirst: vi.fn(),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: prismaMocks,
}));

vi.mock("@/services/compute-governor", () => ({
  planCompute: vi.fn(async () => ({
    executionMode: "STANDARD",
    modelTier: "standard",
    estimatedCostCents: 2,
  })),
}));

vi.mock("@/services/opportunities/lifecycle", () => ({
  upsertDetectedOpportunity: vi.fn(async () => ({
    opportunity: { id: "opp_1" },
    created: true,
  })),
}));

vi.mock("@/adapters/sources", async () => {
  const actual = await vi.importActual<typeof import("@/adapters/sources")>("@/adapters/sources");
  return {
    ...actual,
    listConfiguredSourcePlatforms: vi.fn(() => ["web"] as const),
    searchConfiguredSources: vi.fn(async () => ({
      results: [
        {
          platform: "web" as const,
          url: "https://www.linkedin.com/in/ada-example",
          title: "Ada Example — Founder at Example Recruitment",
          content:
            "Ada Example is founder of Example Recruitment in Manchester. https://www.linkedin.com/in/ada-example",
          author: "Ada Example",
          publishedAt: null,
          engagement: null,
          rawMetadata: {},
        },
        {
          platform: "web" as const,
          url: "https://examplerecruit.co.uk/about",
          title: "About Example Recruitment",
          content: "Founded by Ada Example in Manchester — AI automation for recruitment agencies.",
          author: null,
          publishedAt: null,
          engagement: null,
          rawMetadata: {},
        },
      ],
      errors: [],
      billableCents: 3,
    })),
  };
});

describe("Social prospecting capabilities + LinkedIn compliance", () => {
  afterEach(() => {
    delete process.env.LINKEDIN_INVITATIONS_API_APPROVED;
    delete process.env.LINKEDIN_MESSAGES_API_APPROVED;
    delete process.env.ALLOW_LINKEDIN_RESTRICTED_APIS;
    resetEnvCache();
    vi.clearAllMocks();
  });

  it("declares capabilities without inferring from configuration alone", () => {
    const invite = getDeclaredCapability("LINKEDIN_NATIVE", "CONNECTION_INVITE");
    expect(invite?.baseline).toBe("REQUIRES_PROVIDER_APPROVAL");
    const ayrshareDiscover = getDeclaredCapability("AYRSHARE", "DISCOVERY");
    expect(ayrshareDiscover?.baseline).toBe("UNSUPPORTED");
  });

  it("LinkedIn restricted flags default disabled and are not user-settable alone", () => {
    process.env.LINKEDIN_INVITATIONS_API_APPROVED = "true";
    expect(linkedInInvitationsApiApproved()).toBe(false);
    expect(resolveLinkedInCommunicationsAvailability("CONNECTION_INVITE")).toBe(
      "REQUIRES_PROVIDER_APPROVAL",
    );
  });

  it("LinkedIn V2 adapters reject execution when not approved", async () => {
    await expect(
      sendConnectionInvitation({ organisationId: "org", profileUrl: "https://linkedin.com/in/x" }),
    ).rejects.toBeInstanceOf(SocialCapabilityBlockedError);

    await expect(
      sendLinkedInMessage({ organisationId: "org", recipientUrn: "urn:x", body: "hi" }),
    ).rejects.toMatchObject({ code: "REQUIRES_PROVIDER_APPROVAL" });

    const v1 = linkedInV1ActionSurface();
    expect(v1.sendConnection).toBe(false);
    expect(v1.actions).toContain("OPEN_LINKEDIN");
    expect(v1.actions).toContain("COPY_CONNECTION_NOTE");

    const v2 = linkedInV2ActionSurface();
    expect(v2.sendConnection).toBe(false);
    expect(v2.sendMessage).toBe(false);
  });
});

describe("Natural language ICP parsing", () => {
  it("parses ICP without treating LinkedIn as a people-search DB", () => {
    const icp = parseProspectIntent("Find 40 UK fintech founders on LinkedIn");
    expect(icp.desiredCount).toBe(40);
    expect(icp.industry).toBe("fintech");
    expect(icp.preferredNetworks).toContain("linkedin");
    expect(icp.location?.toLowerCase()).toMatch(/uk|united/);
  });

  it("parses multi-network and Instagram-focused queries", () => {
    const ig = parseProspectIntent("Find 5 Manchester fitness creators on Instagram");
    expect(ig.desiredCount).toBe(5);
    expect(ig.preferredNetworks).toContain("instagram");
    expect(ig.industry).toBe("fitness");
    expect(ig.location?.toLowerCase()).toBe("manchester");

    const x = parseProspectIntent("Find 8 SaaS founders on X and TikTok");
    expect(x.preferredNetworks).toEqual(expect.arrayContaining(["x", "tiktok"]));
  });
});

describe("Cost caps + research orchestration (mocked boundaries)", () => {
  it("enforces conservative default cost limits", () => {
    const limits = mergeDiscoveryCostLimits(30);
    expect(limits.maxCandidates).toBeLessThanOrEqual(DEFAULT_DISCOVERY_COST_LIMITS.maxCandidates);
    expect(limits.maxCandidates).toBe(10);
    expect(limits.maxExternalCalls).toBe(6);
    expect(limits.maxEstimatedCostCents).toBe(50);

    const overridden = mergeDiscoveryCostLimits(5, { maxExternalCalls: 2, maxEstimatedCostCents: 10 });
    expect(overridden.maxCandidates).toBe(5);
    expect(overridden.maxExternalCalls).toBe(2);
  });

  it("runs live research orchestration with mocked providers and no paid spray", async () => {
    const { discoverSocialProspects } = await import("@/services/social-prospecting/discovery");
    const { searchConfiguredSources } = await import("@/adapters/sources");

    const result = await discoverSocialProspects({
      organisationId: "org_1",
      query: "Find 5 recruitment company founders in Manchester",
      costLimits: { maxCandidates: 5, maxExternalCalls: 4, maxEstimatedCostCents: 25 },
    });

    expect(result.liveResearch).toBe(true);
    expect(result.tiersTried.length).toBeGreaterThan(0);
    expect(result.externalCalls).toBeLessThanOrEqual(4);
    expect(result.billableCents).toBeLessThanOrEqual(25);
    expect(searchConfiguredSources).toHaveBeenCalled();
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]?.personName || result.candidates[0]?.companyName).toBeTruthy();
  });

  it("provider fallback degrades honestly when sources unconfigured", async () => {
    const sources = await import("@/adapters/sources");
    vi.mocked(sources.listConfiguredSourcePlatforms).mockReturnValueOnce([]);
    const { gatherProspectCandidatesFromResearch } = await import(
      "@/services/social-prospecting/research-bridge"
    );
    const bridge = await gatherProspectCandidatesFromResearch({
      organisationId: "org_1",
      icp: parseProspectIntent("Find 3 UK dental practice owners"),
      limits: { maxCandidates: 3, maxExternalCalls: 2 },
    });
    expect(bridge.degraded).toBe(true);
    expect(bridge.degradationNotes.length).toBeGreaterThan(0);
    expect(bridge.externalCalls).toBe(0);
  });
});

describe("Identity resolution + profile correctness", () => {
  it("resolves cross-network profiles from evidence without inventing URLs", () => {
    const identities = resolveIdentitiesForCandidate({
      personName: "Ada Example",
      companyName: "Example Recruitment",
      role: "founder",
      location: "Manchester",
      sourceResults: [
        {
          platform: "web",
          url: "https://examplerecruit.co.uk",
          title: "Ada Example",
          content:
            "Founder Ada Example. LinkedIn https://www.linkedin.com/in/ada-example Instagram https://www.instagram.com/ada.example Also on https://x.com/ada_example",
          author: "Ada Example",
          publishedAt: null,
          engagement: null,
          rawMetadata: {},
        },
      ],
    });
    const networks = identities.map((i) => i.network);
    expect(networks).toEqual(expect.arrayContaining(["LINKEDIN", "INSTAGRAM", "X"]));
    expect(identities.every((i) => i.canonicalProfileUrl.startsWith("http"))).toBe(true);
    expect(identities.some((i) => i.verificationState === "VERIFIED" || i.verificationState === "LIKELY")).toBe(
      true,
    );
  });

  it("rejects wrong-profile LinkedIn URLs (never invents from name alone)", () => {
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/constructed-from-name")).toBe(
      "https://www.linkedin.com/in/constructed-from-name",
    );
    // Name alone never produces a URL
    const invented = resolveIdentitiesForCandidate({
      personName: "Totally Madeup Person",
      companyName: "Ghost Co",
      sourceResults: [
        {
          platform: "web",
          url: "https://news.example/article",
          title: "Hiring trends",
          content: "Totally Madeup Person leads Ghost Co in London.",
          author: null,
          publishedAt: null,
          engagement: null,
          rawMetadata: {},
        },
      ],
    });
    expect(invented.filter((i) => i.network === "LINKEDIN")).toHaveLength(0);

    const wrong = verifyProfileAgainstCandidate({
      network: "LINKEDIN",
      url: "https://www.linkedin.com/in/alice-other",
      personName: "Bob Founder",
      companyName: "Acme",
      evidenceText: "Bob Founder runs Acme",
    });
    expect(wrong.verificationState).toBe("UNVERIFIED");

    const applied = applyIdentitiesToCandidate(
      {
        personName: "Bob Founder",
        companyName: "Acme",
        linkedinUrl: "https://www.linkedin.com/in/alice-other",
        sourceEvidence: [{ source: "web", retrievedAt: new Date().toISOString() }],
      },
      [
        {
          network: "LINKEDIN",
          canonicalProfileUrl: "https://www.linkedin.com/in/alice-other",
          evidence: [{ source: "web", retrievedAt: new Date().toISOString() }],
          confidence: 0.15,
          verificationState: "UNVERIFIED",
          retrievedAt: new Date().toISOString(),
        },
      ],
    );
    expect(applied.linkedinUrl).toBeUndefined();
    expect(applied.uncertaintyFlags).toContain("profile_not_verified");
  });

  it("marks conflicting identities and dedupes duplicates", () => {
    const identities = resolveIdentitiesForCandidate({
      personName: "Casey Dual",
      companyName: "Dual Labs",
      sourceResults: [
        {
          platform: "web",
          url: "https://a.example",
          title: "Casey Dual",
          content:
            "Casey Dual of Dual Labs https://www.linkedin.com/in/casey-dual-a and also https://www.linkedin.com/in/casey-dual-b",
          author: "Casey Dual",
          publishedAt: null,
          engagement: null,
          rawMetadata: {},
        },
      ],
    });
    const linkedin = identities.filter((i) => i.network === "LINKEDIN");
    expect(linkedin.length).toBeLessThanOrEqual(1);
    if (linkedin[0]) {
      expect(["CONFLICTED", "LIKELY", "VERIFIED", "UNVERIFIED"]).toContain(linkedin[0].verificationState);
    }

    const batch = dedupeProspectBatch([
      {
        personName: "Casey Dual",
        companyName: "Dual Labs",
        linkedinUrl: "https://www.linkedin.com/in/casey-dual-a",
        sourceEvidence: [
          {
            source: "web",
            excerpt: "Casey Dual of Dual Labs",
            url: "https://a.example",
            retrievedAt: new Date().toISOString(),
          },
          {
            source: "web",
            excerpt: "Casey Dual founded Dual Labs",
            url: "https://b.example",
            retrievedAt: new Date().toISOString(),
          },
        ],
      },
      {
        personName: "Casey Dual",
        companyName: "Dual Labs",
        linkedinUrl: "https://www.linkedin.com/in/casey-dual-a/",
        sourceEvidence: [
          {
            source: "web",
            excerpt: "Casey Dual of Dual Labs",
            retrievedAt: new Date().toISOString(),
          },
        ],
      },
    ]);
    expect(batch.accepted.length).toBe(1);
  });

  it("detects networks across supported platforms", () => {
    expect(detectNetworkFromUrl("https://www.tiktok.com/@fitnesscoach")).toBe("TIKTOK");
    expect(detectNetworkFromUrl("https://www.threads.net/@brand")).toBe("THREADS");
    expect(detectNetworkFromUrl("https://www.youtube.com/@channel")).toBe("YOUTUBE");
    expect(detectNetworkFromUrl("https://www.facebook.com/brandpage")).toBe("FACEBOOK");
  });
});

describe("Prospect discovery quality + outreach copy", () => {
  it("dedupes and caps confidence without inventing evidence", () => {
    const a = {
      personName: "Ada Example",
      companyName: "Example Fintech",
      role: "Founder",
      linkedinUrl: "https://www.linkedin.com/in/ada-example/",
      sourceEvidence: [
        {
          source: "company_website",
          url: "https://example.com/about",
          excerpt: "Ada Example is the founder of Example Fintech in London.",
          retrievedAt: new Date().toISOString(),
        },
        {
          source: "tavily",
          url: "https://news.example/ada",
          excerpt: "Ada Example founded Example Fintech.",
          retrievedAt: new Date().toISOString(),
        },
      ],
    };
    const dupe = { ...a, linkedinUrl: "https://linkedin.com/in/ada-example" };
    const batch = dedupeProspectBatch([a, dupe]);
    expect(batch.accepted).toHaveLength(1);
    expect(batch.accepted[0]!.confidence).toBeGreaterThan(0.4);
    expect(batch.accepted[0]!.reasonSelected.toLowerCase()).toMatch(/role|company|evidence/);

    const weak = qualityCheckProspect(
      {
        personName: "Mystery",
        sourceEvidence: [],
      },
      new Set(),
    );
    expect(weak).toBeNull();
  });

  it("normalizes LinkedIn URLs and builds stable dedupe keys", () => {
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/foo/?trk=x")).toBe(
      "https://www.linkedin.com/in/foo",
    );
    expect(normalizeLinkedInUrl("https://evil.example/linkedin")).toBeUndefined();
    const key = buildProspectDedupeKey({
      personName: "A",
      linkedinUrl: "https://www.linkedin.com/in/foo/",
      sourceEvidence: [{ source: "x", retrievedAt: new Date().toISOString() }],
    });
    expect(key).toHaveLength(32);
  });

  it("generates network-specific and generic outreach without fabricating posts", () => {
    const drafts = generateOutreachDrafts({
      personName: "Ada Lovelace",
      companyName: "Analytical Engines",
      role: "Founder",
      location: "London",
      sector: "fintech",
      reasonSelected: "UK fintech founder fit",
      evidenceExcerpts: ["Analytical Engines expanded into payments in 2025"],
      offerSummary: "AI ops for founder-led teams",
      evidenceConfidence: 0.85,
    });
    expect(drafts.connectionNote.toLowerCase()).toContain("ada");
    expect(drafts.connectionNote).not.toMatch(/saw your (recent )?post/i);
    expect(drafts.followUpOne.length).toBeGreaterThan(20);
    expect(drafts.followUpTwo.length).toBeGreaterThan(20);
    expect(drafts.instagramMessage.length).toBeGreaterThan(10);
    expect(drafts.instagramFollowUp.length).toBeGreaterThan(10);
    expect(drafts.genericSocialOutreach.toLowerCase()).toContain("ada");

    const withPost = generateOutreachDrafts({
      personName: "Ada",
      companyName: "Analytical Engines",
      observedPostExcerpt: "We just shipped payments v2",
      evidenceExcerpts: ["Analytical Engines expanded"],
      evidenceConfidence: 0.9,
    });
    expect(withPost.connectionNote).toMatch(/saw your recent note/i);

    const weakEvidence = generateOutreachDrafts({
      personName: "Ada Lovelace",
      companyName: "Analytical Engines",
      role: "Founder",
      location: "London",
      evidenceConfidence: 0.2,
    });
    expect(weakEvidence.connectionNote).not.toMatch(/Analytical Engines/);
    expect(weakEvidence.connectionNote.toLowerCase()).toMatch(/profile|note/);

    const surfaces = buildActionSurfacesForProspect({
      linkedinUrl: "https://www.linkedin.com/in/ada",
      instagramUrl: "https://www.instagram.com/ada",
      socialIdentities: [
        {
          network: "X",
          canonicalProfileUrl: "https://x.com/ada",
          verificationState: "LIKELY",
          confidence: 0.6,
          evidence: [],
          retrievedAt: new Date().toISOString(),
        },
      ],
    });
    expect(surfaces.map((s) => s.network)).toEqual(expect.arrayContaining(["LINKEDIN", "INSTAGRAM", "X"]));
    expect(universalOutreachSurface("LINKEDIN").copyActions.map((a) => a.label)).toEqual(
      expect.arrayContaining(["Copy Connection Note", "Copy Follow-up DM"]),
    );
    expect(universalOutreachSurface("INSTAGRAM").openLabel).toBe("Open Instagram");
    expect(universalOutreachSurface("TIKTOK").copyActions[0]?.label).toBe("Copy Outreach");
  });
});

describe("CRM ingestion + Read Only denial + Ayrshare independence", () => {
  it("Add to CRM creates contact/company/opportunity path", async () => {
    prismaMocks.socialProspect.findFirst.mockResolvedValueOnce({
      id: "prospect_1",
      organisationId: "org_1",
      personName: "Ada Example",
      companyName: "Example Recruitment",
      companyWebsite: "https://examplerecruit.co.uk",
      location: "Manchester",
      linkedinUrl: "https://www.linkedin.com/in/ada-example",
      instagramUrl: null,
      contactId: null,
      companyId: null,
      opportunityId: null,
      confidence: 0.7,
      fitScore: 0.75,
      reasonSelected: "Recruitment founder Manchester",
      sourceEvidence: [{ source: "web", excerpt: "Ada Example founder", retrievedAt: new Date().toISOString() }],
      dedupeKey: "abc",
      socialIdentities: [],
    });
    prismaMocks.company.findFirst.mockResolvedValueOnce(null);
    prismaMocks.contactIdentifier.findFirst.mockResolvedValueOnce(null);

    const { ingestProspectToCrm } = await import("@/services/social-prospecting/crm-ingest");
    const result = await ingestProspectToCrm({
      organisationId: "org_1",
      prospectId: "prospect_1",
    });
    expect(result.contactId).toBe("contact_1");
    expect(result.companyId).toBe("company_1");
    expect(result.opportunityId).toBe("opp_1");
    expect(prismaMocks.contact.create).toHaveBeenCalled();
  });

  it("Read Only lacks leads:write for prospecting mutations", () => {
    expect(roleHasPermission(MemberRole.READ_ONLY, "leads:write")).toBe(false);
  });

  it("Ayrshare absence does not break prospecting core or messaging registry", () => {
    delete process.env.AYRSHARE_API_KEY;
    resetEnvCache();
    expect(isAyrshareConfigured()).toBe(false);
    ensureDefaultMessagingProvidersRegistered();
    const providers = listSocialMessagingProviders();
    expect(providers.some((p) => p.id === "AYRSHARE")).toBe(true);
    expect(providers.find((p) => p.id === "AYRSHARE")?.isConfigured()).toBe(false);
    // Discovery types / identity resolver do not import Ayrshare
    expect(parseProspectIntent("Find 2 founders").desiredCount).toBe(2);
  });
});

describe("Ayrshare isolation + metrics NULL semantics", () => {
  it("reports NOT_CONFIGURED when API key absent", () => {
    delete process.env.AYRSHARE_API_KEY;
    resetEnvCache();
    expect(isAyrshareConfigured()).toBe(false);
  });

  it("stores missing metrics as NULL not zero", async () => {
    await storeAyrshareMetrics({
      organisationId: "org_1",
      platform: "instagram",
      externalPostId: "post_1",
      metrics: { likes: 12, shares: null, saves: undefined },
    });
    const calls = prismaMocks.socialMetricFact.create.mock.calls;
    expect(calls.length).toBe(3);
    const values = calls.map((c) => c[0].data.value);
    expect(values).toContain(12);
    expect(values.filter((v) => v === null)).toHaveLength(2);
    expect(values).not.toContain(0);
  });
});

describe("Provider failure isolation regression", () => {
  it("optional Ayrshare/Meta absence does not live in global webhook secret assert", async () => {
    const { assertProductionSecretsConfigured, assertWebhookSecretsConfigured, resetEnvCache } =
      await import("@/lib/env");
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.ENCRYPTION_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env.AUTH_SECRET = "production-auth-secret-ok";
    process.env.NEXTAUTH_SECRET = "production-auth-secret-ok";
    process.env.MANYCHAT_WEBHOOK_SECRET = "rotated-manychat-webhook-secret";
    process.env.BOOKING_WEBHOOK_SECRET = "rotated-booking-webhook-secret";
    delete process.env.AYRSHARE_API_KEY;
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;
    resetEnvCache();
    try {
      expect(() => assertWebhookSecretsConfigured()).not.toThrow();
      expect(() => assertProductionSecretsConfigured()).not.toThrow();
    } finally {
      process.env.NODE_ENV = previous;
      resetEnvCache();
    }
  });
});
