import { describe, expect, it } from "vitest";
import {
  attachVisibleResearchEvidence,
  normalizeVisibleFindings,
  normalizeVisibleSources,
} from "@/lib/research-visible-evidence";

const HIRE = "https://hire.example/rates";

describe("visible research evidence", () => {
  it("lists fetched sources even when findings are empty", () => {
    const payload = {
      researchJobId: "job_1",
      sources: [
        {
          url: HIRE,
          title: "UK plant hire day rates",
          content: "A 3-tonne excavator typically hires from £120 per day.",
          author: "Hire Desk",
          platform: "web",
        },
      ],
      findings: [],
    };
    const sources = normalizeVisibleSources(payload);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toBe(HIRE);
    expect(sources[0]?.snippet).toMatch(/£120/);
    const findings = normalizeVisibleFindings(payload, sources);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.sourceUrl).toBe(HIRE);
    expect(findings[0]?.evidenceExcerpt).toMatch(/£120/);
  });

  it("links each finding to its source URL and backfills excerpt from the source snippet", () => {
    const attached = attachVisibleResearchEvidence({
      researchJobId: "job_2",
      findings: [
        {
          claim: "Day rates are published by hire houses.",
          sourceUrl: HIRE,
        },
      ],
      sources: [
        {
          url: HIRE,
          title: "UK plant hire day rates",
          snippet: "Published day rates for 3-tonne excavators.",
        },
      ],
    }) as {
      findings: Array<{ sourceUrl: string; evidenceExcerpt?: string; sourceTitle?: string }>;
      sources: Array<{ url: string }>;
    };
    expect(attached.findings[0]?.sourceUrl).toBe(HIRE);
    expect(attached.findings[0]?.evidenceExcerpt).toMatch(/Published day rates/);
    expect(attached.findings[0]?.sourceTitle).toMatch(/plant hire/i);
    expect(attached.sources[0]?.url).toBe(HIRE);
  });

  it("does not invent findings for CRM desk answers", () => {
    const crm = attachVisibleResearchEvidence({
      source: "internal_crm",
      shortAnswer: "Three deals need a reply.",
    }) as { findings?: unknown; sources?: unknown };
    expect(crm.findings).toBeUndefined();
    expect(crm.sources).toBeUndefined();
  });
});
