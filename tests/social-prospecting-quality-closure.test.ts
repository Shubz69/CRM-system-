import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProspectIntent } from "@/services/social-prospecting/types";
import { dedupeProspectBatch, qualityCheckProspect } from "@/services/social-prospecting/quality";
import {
  isPlausibleHumanName,
  isScrapedFragment,
  validateProspectCandidate,
  shouldPersistCompany,
  isWeakCompanyName,
} from "@/services/social-prospecting/entity-validation";
import { ingestProspectToCrm } from "@/services/social-prospecting/crm-ingest";
import { discoverSocialProspects } from "@/services/social-prospecting/discovery";
import { generateOutreachDrafts } from "@/services/social-prospecting/outreach";
import { MemberRole } from "@prisma/client";
import { roleHasPermission } from "@/lib/permissions";

const prismaMocks = vi.hoisted(() => ({
  socialProspect: {
    upsert: vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
      id: `p_${Math.random().toString(36).slice(2, 8)}`,
      ...args.create,
      ...args.update,
    })),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
  },
  socialProviderUsage: { create: vi.fn(async () => ({})) },
  contact: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "contact_1", ...args.data })),
    findFirst: vi.fn(),
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

vi.mock("@/lib/db", () => ({ prisma: prismaMocks }));
vi.mock("@/services/compute-governor", () => ({
  planCompute: vi.fn(async () => ({ executionMode: "STANDARD" })),
}));
vi.mock("@/services/opportunities/lifecycle", () => ({
  upsertDetectedOpportunity: vi.fn(async () => ({ opportunity: { id: "opp_1" }, created: true })),
}));

function evidence(excerpt: string, url?: string) {
  return {
    source: "web",
    excerpt,
    url,
    retrievedAt: new Date().toISOString(),
  };
}

describe("Final social prospecting quality closure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects listicle / scraped fragments as non-persons", () => {
    expect(isPlausibleHumanName("Recruitment Founders Club · who bring proven")).toBe(false);
    expect(isScrapedFragment("Recruitment Founders Club · who bring proven")).toBe(true);
    expect(isPlausibleHumanName("United Kingdom · About Over 19 years...")).toBe(false);

    const icp = parseProspectIntent("5 UK recruitment company founders");
    const decision = validateProspectCandidate(
      {
        personName: "Recruitment Founders Club · who bring proven",
        sourceEvidence: [evidence("Recruitment Founders Club · who bring proven")],
      },
      icp,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.rejectionCode).toBeTruthy();
  });

  it("rejects company LinkedIn pages as person profiles", () => {
    const icp = parseProspectIntent("5 UK recruitment company founders");
    const decision = validateProspectCandidate(
      {
        personName: "Tiger Recruitment",
        linkedinUrl: "https://www.linkedin.com/company/tiger-recruitment",
        sourceEvidence: [evidence("Tiger Recruitment company page", "https://www.linkedin.com/company/tiger")],
      },
      icp,
    );
    expect(decision.accepted).toBe(false);
  });

  it("rejects recruiter for founders intent (role mismatch)", () => {
    const icp = parseProspectIntent("5 UK recruitment company founders");
    expect(icp.role).toMatch(/founder/i);
    const decision = validateProspectCandidate(
      {
        personName: "Sam Recruiter",
        role: "Recruiter",
        location: "London",
        linkedinUrl: "https://www.linkedin.com/in/sam-recruiter",
        socialIdentities: [
          {
            network: "LINKEDIN",
            canonicalProfileUrl: "https://www.linkedin.com/in/sam-recruiter",
            verificationState: "VERIFIED",
            confidence: 0.9,
            evidence: [evidence("Sam Recruiter is a recruitment expert in London UK")],
            retrievedAt: new Date().toISOString(),
          },
        ],
        sourceEvidence: [
          evidence("Sam Recruiter is a recruitment expert and consultant in London UK", "https://www.linkedin.com/in/sam-recruiter"),
        ],
      },
      icp,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.rejectionCode).toBe("ROLE_MISMATCH");
  });

  it("rejects London Kentucky for London UK geography", () => {
    const icp = parseProspectIntent("5 London dental practice owners");
    const decision = validateProspectCandidate(
      {
        personName: "Jamie Dentist",
        role: "Owner",
        location: "London, Kentucky",
        linkedinUrl: "https://www.linkedin.com/in/jamie-dentist",
        socialIdentities: [
          {
            network: "LINKEDIN",
            canonicalProfileUrl: "https://www.linkedin.com/in/jamie-dentist",
            verificationState: "VERIFIED",
            confidence: 0.9,
            evidence: [evidence("Jamie Dentist, dental practice owner in London, Kentucky")],
            retrievedAt: new Date().toISOString(),
          },
        ],
        sourceEvidence: [
          evidence("Jamie Dentist owns a dental practice in London, Kentucky USA"),
        ],
      },
      icp,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.rejectionCode).toBe("LOCATION_MISMATCH");
  });

  it("rejects Instagram privacy policy and listicle titles", () => {
    const icp = parseProspectIntent("5 Manchester fitness creators on Instagram");
    const privacy = validateProspectCandidate(
      {
        personName: "Privacy Policy",
        instagramUrl: "https://www.instagram.com/legal/privacy",
        sourceEvidence: [evidence("Instagram privacy policy", "https://www.instagram.com/legal/privacy")],
      },
      icp,
    );
    expect(privacy.accepted).toBe(false);

    const listicle = validateProspectCandidate(
      {
        personName: "Top 10 Fitness",
        sourceEvidence: [evidence("Top 10 fitness creators in Manchester on Instagram")],
      },
      icp,
    );
    expect(listicle.accepted).toBe(false);
  });

  it("accepts verified Instagram creator handle with evidence", () => {
    const icp = parseProspectIntent("5 Manchester fitness creators on Instagram");
    const decision = validateProspectCandidate(
      {
        personName: "Alex Fitness",
        role: "Creator",
        location: "Manchester",
        instagramUrl: "https://www.instagram.com/alexfitness",
        socialIdentities: [
          {
            network: "INSTAGRAM",
            canonicalProfileUrl: "https://www.instagram.com/alexfitness",
            handle: "alexfitness",
            verificationState: "VERIFIED",
            confidence: 0.9,
            evidence: [evidence("Alex Fitness Manchester fitness creator")],
            retrievedAt: new Date().toISOString(),
          },
        ],
        sourceEvidence: [
          evidence(
            "Alex Fitness is a Manchester fitness creator on Instagram https://www.instagram.com/alexfitness",
            "https://www.instagram.com/alexfitness",
          ),
        ],
      },
      icp,
    );
    expect(decision.accepted).toBe(true);
    expect(decision.entityClass).toMatch(/PERSON|CREATOR/);
  });

  it("dedupes duplicate LinkedIn URLs across candidates", () => {
    const icp = parseProspectIntent("5 UK recruitment company founders");
    const shared = {
      linkedinUrl: "https://www.linkedin.com/in/david-morel",
      location: "London",
      role: "Founder",
      socialIdentities: [
        {
          network: "LINKEDIN" as const,
          canonicalProfileUrl: "https://www.linkedin.com/in/david-morel",
          verificationState: "VERIFIED" as const,
          confidence: 0.9,
          evidence: [evidence("David Morel founder")],
          retrievedAt: new Date().toISOString(),
        },
      ],
      sourceEvidence: [
        evidence("David Morel is founder of Tiger Recruitment in London UK", "https://www.linkedin.com/in/david-morel"),
      ],
    };
    const batch = dedupeProspectBatch(
      [
        { personName: "David Morel", companyName: "Tiger Recruitment", ...shared },
        { personName: "David M", companyName: "Tiger", ...shared },
      ],
      icp,
    );
    expect(batch.accepted.length).toBe(1);
    expect(batch.rejected.some((r) => r.rejectionCode === "DUPLICATE_PROFILE")).toBe(true);
  });

  it("returns only quality matches — never pads to requested count", async () => {
    const result = await discoverSocialProspects({
      organisationId: "org_1",
      query: "5 UK recruitment company founders",
      skipLiveResearch: true,
      seedCandidates: [
        {
          personName: "David Morel",
          companyName: "Tiger Recruitment",
          role: "Founder",
          location: "London",
          linkedinUrl: "https://www.linkedin.com/in/david-morel",
          sourceEvidence: [
            evidence("David Morel is Founder of Tiger Recruitment in London UK"),
            evidence("Tiger Recruitment founded by David Morel"),
          ],
        },
        {
          personName: "Aleksandra Remplewicz",
          companyName: "Example Recruit",
          role: "Co-Founder",
          location: "Manchester",
          linkedinUrl: "https://www.linkedin.com/in/aleksandra-remplewicz",
          sourceEvidence: [
            evidence("Aleksandra Remplewicz Co-Founder at Example Recruit Manchester UK"),
          ],
        },
        {
          personName: "Recruitment Founders Club · who bring proven",
          sourceEvidence: [evidence("Recruitment Founders Club · who bring proven")],
        },
        {
          personName: "Sam Recruiter",
          role: "Recruiter",
          location: "London",
          linkedinUrl: "https://www.linkedin.com/in/sam-recruiter",
          sourceEvidence: [evidence("Sam Recruiter recruitment expert London UK")],
        },
      ],
    });
    expect(result.searchRunId).toMatch(/^run_/);
    expect(result.returnedCount).toBeLessThanOrEqual(3);
    expect(result.returnedCount).toBe(result.candidates.length);
    expect(result.requestedCount).toBe(5);
    if (result.returnedCount < 5) {
      expect(result.qualityNote).toMatch(/sufficiently verified/i);
    }
    expect(result.candidates.every((c) => isPlausibleHumanName(c.personName))).toBe(true);
  });

  it("isolates search runs — query B does not mix with query A candidates list", async () => {
    const a = await discoverSocialProspects({
      organisationId: "org_1",
      query: "2 UK recruitment company founders",
      skipLiveResearch: true,
      seedCandidates: [
        {
          personName: "David Morel",
          companyName: "Tiger Recruitment",
          role: "Founder",
          location: "London",
          linkedinUrl: "https://www.linkedin.com/in/david-morel",
          sourceEvidence: [evidence("David Morel Founder Tiger Recruitment London UK")],
        },
      ],
    });
    const b = await discoverSocialProspects({
      organisationId: "org_1",
      query: "2 London dental practice owners",
      skipLiveResearch: true,
      seedCandidates: [
        {
          personName: "Laurence Baum",
          companyName: "Dental Practice",
          role: "Owner",
          location: "London",
          linkedinUrl: "https://www.linkedin.com/in/laurence-baum",
          sourceEvidence: [evidence("Laurence Baum owner of dental practice in London UK")],
        },
      ],
    });
    expect(a.searchRunId).not.toBe(b.searchRunId);
    expect(a.candidates.every((c) => c.researchJobId === a.searchRunId)).toBe(true);
    expect(b.candidates.every((c) => c.researchJobId === b.searchRunId)).toBe(true);
    expect(b.candidates.some((c) => c.personName === "David Morel")).toBe(false);
  });

  it("creates Company when evidence is strong; skips garbled/weak company", async () => {
    expect(isWeakCompanyName("Headless Cross")).toBe(true);
    expect(shouldPersistCompany({ companyName: "Headless Cross", personName: "X" })).toBe(false);

    prismaMocks.socialProspect.findFirst.mockResolvedValue({
      id: "prospect_strong",
      organisationId: "org_1",
      personName: "David Morel",
      companyName: "Tiger Recruitment",
      companyWebsite: "https://www.tiger-recruitment.com",
      linkedinUrl: "https://www.linkedin.com/in/david-morel",
      instagramUrl: null,
      companyId: null,
      contactId: null,
      opportunityId: null,
      confidence: 0.8,
      fitScore: 0.8,
      dedupeKey: "dk1",
      reasonSelected: "Founder",
      sourceEvidence: [
        evidence("David Morel is Founder of Tiger Recruitment", "https://www.tiger-recruitment.com"),
      ],
    });
    prismaMocks.company.findFirst.mockResolvedValue(null);
    prismaMocks.contactIdentifier.findFirst.mockResolvedValue(null);

    const strong = await ingestProspectToCrm({
      organisationId: "org_1",
      prospectId: "prospect_strong",
    });
    expect(strong.companyId).toBe("company_1");
    expect(strong.companyCreated).toBe(true);
    expect(prismaMocks.company.create).toHaveBeenCalled();

    prismaMocks.company.create.mockClear();
    prismaMocks.socialProspect.findFirst.mockResolvedValue({
      id: "prospect_weak",
      organisationId: "org_1",
      personName: "Jamie Dentist",
      companyName: "Headless Cross",
      companyWebsite: null,
      linkedinUrl: null,
      instagramUrl: null,
      companyId: null,
      contactId: null,
      opportunityId: null,
      confidence: 0.5,
      fitScore: 0.5,
      dedupeKey: "dk2",
      reasonSelected: "Owner",
      sourceEvidence: [evidence("Jamie Dentist Headless Cross snippet garbage")],
    });
    const weak = await ingestProspectToCrm({
      organisationId: "org_1",
      prospectId: "prospect_weak",
    });
    expect(weak.companyId).toBeNull();
    expect(weak.companySkippedReason).toBeTruthy();
    expect(prismaMocks.company.create).not.toHaveBeenCalled();
  });

  it("reuses existing Company by domain — no duplicate", async () => {
    prismaMocks.socialProspect.findFirst.mockResolvedValue({
      id: "prospect_exist",
      organisationId: "org_1",
      personName: "David Morel",
      companyName: "Tiger Recruitment",
      companyWebsite: "https://www.tiger-recruitment.com/about",
      linkedinUrl: "https://www.linkedin.com/in/david-morel",
      instagramUrl: null,
      companyId: null,
      contactId: null,
      opportunityId: null,
      confidence: 0.85,
      fitScore: 0.85,
      dedupeKey: "dk3",
      reasonSelected: "Founder",
      sourceEvidence: [
        evidence("David Morel Founder Tiger Recruitment", "https://www.tiger-recruitment.com"),
      ],
    });
    prismaMocks.company.findFirst.mockResolvedValue({
      id: "company_existing",
      website: null,
      domain: "tiger-recruitment.com",
    });
    prismaMocks.contactIdentifier.findFirst.mockResolvedValue(null);
    const result = await ingestProspectToCrm({
      organisationId: "org_1",
      prospectId: "prospect_exist",
    });
    expect(result.companyId).toBe("company_existing");
    expect(result.companyCreated).toBe(false);
  });

  it("high fit cannot compensate for weak identity (hard gate)", () => {
    const icp = parseProspectIntent("5 UK recruitment company founders");
    const checked = qualityCheckProspect(
      {
        personName: "Vague Person",
        role: "Founder",
        location: "London",
        fitScore: 0.95,
        confidence: 0.95,
        sourceEvidence: [evidence("Vague Person somehow related founder London UK")],
      },
      new Set(),
      icp,
    );
    expect(checked?.ok).toBe(false);
  });

  it("outreach degrades gracefully with weak evidence", () => {
    const weak = generateOutreachDrafts({
      personName: "Ada Lovelace",
      companyName: "Analytical Engines",
      role: "Founder",
      location: "London",
      evidenceConfidence: 0.2,
    });
    expect(weak.connectionNote).not.toMatch(/Analytical Engines/);
  });

  it("customer integrations UI does not expose vendor internals", () => {
    const text = readFileSync(
      join(process.cwd(), "src/app/(app)/integrations/integrations-client.tsx"),
      "utf8",
    );
    expect(text).not.toMatch(/\bManyChat\b/);
    expect(text).not.toMatch(/Meta app not configured/);
    expect(text).not.toMatch(/\bZernio\b/);
    expect(text).not.toMatch(/\bAyrshare\b/);
    expect(text).not.toMatch(/\bClaude\b/);
    expect(text).not.toMatch(/\bAnthropic\b/);
    expect(text).not.toMatch(/\bOpenAI\b/);
    expect(text).not.toMatch(/AI Provider/);
  });

  it("workspace admin lacks platform social quota permission", () => {
    expect(roleHasPermission(MemberRole.ADMINISTRATOR, "platform:manage")).toBe(false);
    expect(roleHasPermission(MemberRole.OWNER, "platform:manage")).toBe(false);
    expect(roleHasPermission(MemberRole.SUPER_ADMIN, "platform:manage")).toBe(true);
  });
});
