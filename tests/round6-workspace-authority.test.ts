import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  ALL_WORKSPACE_STORAGE_KEYS,
  ACK_KEY,
  IMMUTABLE_CONTEXT_KEY,
  STORAGE_EVENT_KEY,
  STORAGE_SCHEMA_VERSION,
  STORAGE_SCHEMA_VERSION_KEY,
  getImmutableWorkspaceContext,
  migrateWorkspaceStorage,
  prepareWorkspaceTabReload,
  setImmutableWorkspaceContext,
  workspaceGateShouldBlock,
} from "@/lib/workspace-client";
import {
  classifyResearchStakes,
  authorityFirstQueries,
  isPrimaryAuthorityUrl,
  HIGH_STAKES_NO_PRIMARY_SOURCE_QUALITY_CAP,
} from "@/lib/research-authority";
import { scoreResearchQuality } from "@/services/research-quality";

describe("Round 6 workspace storage migration", () => {
  let session: Map<string, string>;
  let local: Map<string, string>;

  beforeEach(() => {
    session = new Map();
    local = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => session.set(k, v),
      removeItem: (k: string) => session.delete(k),
    });
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => local.set(k, v),
      removeItem: (k: string) => local.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("exports allowlisted workspace keys only", () => {
    expect(ALL_WORKSPACE_STORAGE_KEYS).toEqual(
      expect.arrayContaining([
        STORAGE_EVENT_KEY,
        IMMUTABLE_CONTEXT_KEY,
        ACK_KEY,
        STORAGE_SCHEMA_VERSION_KEY,
      ]),
    );
    expect(STORAGE_SCHEMA_VERSION).toBe(6);
  });

  it("removes legacy localStorage immutable context and versions storage", () => {
    local.set(IMMUTABLE_CONTEXT_KEY, JSON.stringify({ loadedOrganisationId: "org-a" }));
    const result = migrateWorkspaceStorage();
    expect(local.get(IMMUTABLE_CONTEXT_KEY)).toBeUndefined();
    expect(local.get(STORAGE_SCHEMA_VERSION_KEY)).toBe(String(STORAGE_SCHEMA_VERSION));
    expect(result.fromVersion).toBeLessThanOrEqual(STORAGE_SCHEMA_VERSION);
  });

  it("treats session snapshot without documentLoadId as stale", () => {
    session.set(
      IMMUTABLE_CONTEXT_KEY,
      JSON.stringify({ loadedOrganisationId: "org-a", workspaceRevision: "2020-01-01T00:00:00.000Z" }),
    );
    migrateWorkspaceStorage();
    const snap = getImmutableWorkspaceContext("org-b");
    expect(snap.loadedOrganisationId).toBe("org-b");
    expect(snap.workspaceRevision).toBeNull();
  });

  it("prepareWorkspaceTabReload clears tab snapshot but keeps global event", () => {
    local.set(
      STORAGE_EVENT_KEY,
      JSON.stringify({
        type: "org-changed",
        organisationId: "org-b",
        organisationName: "B",
        changeId: "c1",
      }),
    );
    session.set(IMMUTABLE_CONTEXT_KEY, JSON.stringify({ loadedOrganisationId: "org-a", documentLoadId: "x" }));
    session.set(ACK_KEY, "c1");
    prepareWorkspaceTabReload();
    expect(session.get(IMMUTABLE_CONTEXT_KEY)).toBeUndefined();
    expect(session.get(ACK_KEY)).toBeUndefined();
    expect(local.get(STORAGE_EVENT_KEY)).toBeTruthy();
  });

  it("does not re-block after freeze into destination org", () => {
    local.set(
      STORAGE_EVENT_KEY,
      JSON.stringify({
        type: "org-changed",
        organisationId: "org-b",
        organisationName: "B",
        workspaceRevision: "2026-01-02T00:00:00.000Z",
        changeId: "switch-1",
      }),
    );
    prepareWorkspaceTabReload();
    setImmutableWorkspaceContext({
      loadedOrganisationId: "org-b",
      workspaceRevision: "2026-01-02T00:00:00.000Z",
    });
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: "org-b",
        currentWorkspaceRevision: "2026-01-02T00:00:00.000Z",
        event: JSON.parse(local.get(STORAGE_EVENT_KEY)!),
      }),
    ).toBe(false);
  });
});

describe("Round 6 research authority", () => {
  it("classifies GDPR as high-stakes and plans authority-first queries", () => {
    const prompt =
      "Research the current UK GDPR requirements for storing customer contact details in a CRM. Prioritise authoritative UK sources.";
    expect(classifyResearchStakes(prompt)).toBe("HIGH_STAKES_REGULATORY");
    const q = authorityFirstQueries(prompt);
    expect(q.some((x) => /site:ico\.org\.uk/i.test(x))).toBe(true);
    expect(q.some((x) => /site:gov\.uk/i.test(x))).toBe(true);
  });

  it("caps source quality and hard-fails when high-stakes has zero primary sources", () => {
    const prompt =
      "Research the current UK GDPR requirements for storing customer contact details in a CRM.";
    const report = scoreResearchQuality({
      originalUserPrompt: prompt,
      researchTopic: prompt,
      claims: [
        {
          claim: "CRMs must store data in the UK.",
          sourceUrl: "https://bespoke-crms.com/blog/gdpr",
          evidenceExcerpt: "store data",
          claimKind: "OFFICIAL",
          confidence: 0.8,
        },
      ],
      sources: [
        {
          url: "https://bespoke-crms.com/blog/gdpr",
          title: "Vendor guide",
          platform: "web",
          publishedAt: new Date().toISOString(),
          freshnessScore: 0.9,
        },
        {
          url: "https://smartpubtools.com/gdpr-guide",
          title: "Another blog",
          platform: "web",
          publishedAt: new Date().toISOString(),
          freshnessScore: 0.8,
        },
      ],
    });
    expect(report.breakdown.sourceQuality).toBeLessThanOrEqual(
      HIGH_STAKES_NO_PRIMARY_SOURCE_QUALITY_CAP,
    );
    expect(report.accepted).toBe(false);
    expect(report.hardGateFailures.some((f) => /primary authority/i.test(f.message))).toBe(true);
  });

  it("recognises ICO / GOV.UK as primary authority", () => {
    expect(isPrimaryAuthorityUrl("https://ico.org.uk/for-organisations/uk-gdpr")).toBe(true);
    expect(isPrimaryAuthorityUrl("https://www.gov.uk/data-protection")).toBe(true);
    expect(isPrimaryAuthorityUrl("https://www.legislation.gov.uk/ukpga/2018/12")).toBe(true);
    expect(isPrimaryAuthorityUrl("https://vendor-blog.example/gdpr")).toBe(false);
  });
});
