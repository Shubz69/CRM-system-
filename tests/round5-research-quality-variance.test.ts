import { describe, expect, it } from "vitest";
import {
  scoreResearchQuality,
  customerQualitySummary,
  RESEARCH_ACCEPTANCE,
} from "@/services/research-quality";

const NOW = new Date().toISOString();
const STALE = "2018-03-01T00:00:00.000Z";

const ONS = {
  url: "https://www.ons.gov.uk/businessindustryandtrade/abc",
  title: "ONS — Business AI adoption",
  platform: "web",
  publishedAt: NOW,
  freshnessScore: 0.95,
};
const BBC = {
  url: "https://www.bbc.com/news/technology-ai-sme",
  title: "BBC — UK SMEs and AI",
  platform: "web",
  publishedAt: NOW,
  freshnessScore: 0.9,
};
const FT = {
  url: "https://www.ft.com/content/ai-sme-uk",
  title: "FT — AI adoption among UK firms",
  platform: "web",
  publishedAt: NOW,
  freshnessScore: 0.85,
};
const GOV = {
  url: "https://www.gov.uk/guidance/ai-adoption",
  title: "GOV.UK AI guidance",
  platform: "web",
  publishedAt: NOW,
  freshnessScore: 0.9,
};
const BLOG = {
  url: "https://medium.com/@someone/ai-hype-post",
  title: "Why every SME must buy our AI tool",
  platform: "web",
  publishedAt: NOW,
  freshnessScore: 0.7,
};
const SUBSTACK = {
  url: "https://examplewriter.substack.com/p/ai-takes",
  title: "Hot takes on AI",
  platform: "web",
  publishedAt: NOW,
  freshnessScore: 0.6,
};

const PROMPT = "Research UK SME AI adoption rates with sources";

describe("Round 5 research quality variance", () => {
  it("excellent official multi-source scores high and can accept", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "UK SME AI adoption is rising according to ONS survey data.",
          sourceUrl: ONS.url,
          evidenceExcerpt: "ONS survey data shows rising AI adoption among UK SMEs in 2025",
          claimKind: "OFFICIAL",
          confidence: 0.95,
        },
        {
          claim: "BBC reports cost and skills remain barriers for smaller firms.",
          sourceUrl: BBC.url,
          evidenceExcerpt: "cost and skills remain barriers for smaller firms",
          claimKind: "OBSERVATION",
          confidence: 0.9,
        },
        {
          claim: "FT notes mid-market firms investing in copilots.",
          sourceUrl: FT.url,
          evidenceExcerpt: "mid-market firms investing in copilots",
          claimKind: "OBSERVATION",
          confidence: 0.85,
        },
        {
          claim: "GOV.UK publishes practical adoption guidance for smaller organisations.",
          sourceUrl: GOV.url,
          evidenceExcerpt: "practical adoption guidance for smaller organisations",
          claimKind: "OFFICIAL",
          confidence: 0.9,
        },
      ],
      sources: [ONS, BBC, FT, GOV],
      finalAnswerText:
        "UK SME AI adoption is rising. ONS survey data and BBC/FT reporting show cost and skills barriers remain while mid-market firms invest in copilots. GOV.UK also publishes practical adoption guidance for smaller organisations.",
      gaps: ["Exact percentage varies by survey year."],
      contradictions: [],
    });
    expect(report.breakdown.promptFidelity).toBeGreaterThanOrEqual(RESEARCH_ACCEPTANCE.promptFidelityMin);
    expect(report.breakdown.factualAccuracy).toBeGreaterThanOrEqual(80);
    expect(report.overall).toBeGreaterThanOrEqual(80);
    expect(report.hardGateFailures.some((f) => f.code === "FABRICATED_URL")).toBe(false);
  });

  it("strong mixed sources score below excellent but above weak packs", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "ONS shows rising UK SME AI adoption.",
          sourceUrl: ONS.url,
          evidenceExcerpt: "rising AI adoption among UK SMEs",
          claimKind: "OFFICIAL",
          confidence: 0.85,
        },
        {
          claim: "A trade blog summarises vendor survey results.",
          sourceUrl: BLOG.url,
          evidenceExcerpt: "vendor survey results among SMEs",
          claimKind: "OBSERVATION",
          confidence: 0.55,
        },
      ],
      sources: [ONS, BLOG],
      finalAnswerText:
        "ONS shows rising UK SME AI adoption. A trade blog summarises vendor survey results among SMEs.",
      gaps: ["Blog evidence is secondary."],
    });
    expect(report.breakdown.sourceQuality).toBeLessThan(95);
    expect(report.overall).toBeGreaterThan(40);
  });

  it("marketing-blog-only is not high confidence / not accepted", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "Every UK SME will adopt AI this quarter.",
          sourceUrl: BLOG.url,
          evidenceExcerpt: "every SME will adopt AI this quarter",
          claimKind: "RECOMMENDATION",
          confidence: 0.4,
        },
        {
          claim: "Our product doubles conversion overnight.",
          sourceUrl: SUBSTACK.url,
          evidenceExcerpt: "doubles conversion overnight",
          claimKind: "RECOMMENDATION",
          confidence: 0.3,
        },
      ],
      sources: [BLOG, SUBSTACK],
      finalAnswerText: "Every UK SME will adopt AI this quarter and our product doubles conversion overnight.",
      gaps: [],
    });
    expect(report.breakdown.sourceQuality).toBeLessThan(70);
    expect(report.accepted).toBe(false);
    expect(report.confidenceLabel).not.toBe("High confidence");
    expect(report.overall).toBeLessThan(90);
  });

  it("single weak source pack scores poorly on cross-verification / uncertainty", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        { claim: "Claim one about UK SME AI", sourceUrl: BLOG.url, evidenceExcerpt: "excerpt one here" },
        { claim: "Claim two about UK SME AI", sourceUrl: BLOG.url, evidenceExcerpt: "excerpt two here" },
        { claim: "Claim three about UK SME AI", sourceUrl: BLOG.url, evidenceExcerpt: "excerpt three here" },
      ],
      sources: [BLOG],
      finalAnswerText: "UK SME AI adoption notes from one marketing blog only.",
      gaps: [],
    });
    expect(report.breakdown.crossVerification).toBeLessThan(70);
    expect(report.breakdown.uncertainty).toBeLessThan(60);
    expect(report.accepted).toBe(false);
  });

  it("stale sources reduce freshness relative to fresh packs", () => {
    const stale = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "A 2018 survey described early AI interest among UK SMEs.",
          sourceUrl: "https://www.ons.gov.uk/archive/2018-ai",
          evidenceExcerpt: "early AI interest among UK SMEs in 2018",
          claimKind: "OFFICIAL",
          confidence: 0.7,
        },
      ],
      sources: [
        {
          url: "https://www.ons.gov.uk/archive/2018-ai",
          title: "ONS archive 2018",
          publishedAt: STALE,
          freshnessScore: 0.15,
        },
      ],
      finalAnswerText: "A 2018 survey described early AI interest among UK SMEs.",
      gaps: ["Data is several years old."],
    });
    const fresh = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "Recent ONS data shows rising UK SME AI adoption.",
          sourceUrl: ONS.url,
          evidenceExcerpt: "rising AI adoption among UK SMEs",
          claimKind: "OFFICIAL",
          confidence: 0.9,
        },
      ],
      sources: [ONS],
      finalAnswerText: "Recent ONS data shows rising UK SME AI adoption.",
      gaps: ["Single primary source."],
    });
    expect(stale.breakdown.freshness).toBeLessThan(fresh.breakdown.freshness);
  });

  it("conflicting sources surface honest disagreement differently from clean packs", () => {
    const conflicting = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "ONS reports rising UK SME AI adoption.",
          sourceUrl: ONS.url,
          evidenceExcerpt: "rising AI adoption among UK SMEs",
          claimKind: "OFFICIAL",
          confidence: 0.9,
        },
        {
          claim: "BBC reports adoption has plateaued among smaller firms.",
          sourceUrl: BBC.url,
          evidenceExcerpt: "adoption has plateaued among smaller firms",
          claimKind: "OBSERVATION",
          confidence: 0.8,
        },
      ],
      sources: [ONS, BBC],
      finalAnswerText:
        "ONS reports rising UK SME AI adoption while BBC reports adoption has plateaued among smaller firms.",
      gaps: ["Survey definitions differ."],
      contradictions: [
        {
          description: "Rising vs plateaued adoption rates across ONS and BBC.",
          sourceUrls: [ONS.url, BBC.url],
        },
      ],
    });
    expect(conflicting.breakdown.uncertainty).toBeGreaterThanOrEqual(70);
    expect(conflicting.breakdown.crossVerification).toBeGreaterThan(40);
  });

  it("wrong-intent social framing fails hard gates for factual business prompts", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "Viral hooks and reels are trending for creators.",
          sourceUrl: BBC.url,
          evidenceExcerpt: "viral hooks for creators",
          claimKind: "OBSERVATION",
        },
      ],
      sources: [BBC],
      finalAnswerText: "Viral talk about hooks and formats for trending posts on reels.",
    });
    expect(report.accepted).toBe(false);
    expect(report.hardGateFailures.some((f) => f.code === "WRONG_INTENT")).toBe(true);
    expect(report.overall).toBeLessThan(90);
  });

  it("unsupported definitive claim hard-fails", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "Exactly 64.2% of UK SMEs use generative AI daily.",
          claimKind: "OFFICIAL",
        },
      ],
      sources: [ONS],
      finalAnswerText: "Exactly 64.2% of UK SMEs use generative AI daily.",
    });
    expect(report.accepted).toBe(false);
    expect(
      report.hardGateFailures.some(
        (f) => f.code === "UNSUPPORTED_DEFINITIVE_CLAIM" || f.code === "FACTUAL_ACCURACY_BELOW_THRESHOLD",
      ),
    ).toBe(true);
  });

  it("fabricated URL hard-fails", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "Exactly 87.3% of UK SMEs use AI.",
          sourceUrl: "https://example.com/fake-stat",
          claimKind: "OFFICIAL",
        },
      ],
      sources: [ONS],
      finalAnswerText: "Exactly 87.3% of UK SMEs use AI per Example.",
    });
    expect(report.accepted).toBe(false);
    expect(report.hardGateFailures.some((f) => f.code === "FABRICATED_URL")).toBe(true);
  });

  it("high-quality sources with insufficient claim support do not fake acceptance", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "UK SME AI adoption jumped 400% overnight with no caveats.",
          sourceUrl: ONS.url,
          // No evidence excerpt — weak support despite A-tier URL
          claimKind: "OFFICIAL",
          confidence: 0.95,
        },
      ],
      sources: [ONS, BBC, FT],
      finalAnswerText: "UK SME AI adoption jumped 400% overnight with no caveats.",
      gaps: [],
    });
    // Strong hosts alone must not invent a high accepted score without support.
    expect(report.accepted).toBe(false);
    expect(report.overall).toBeLessThan(RESEARCH_ACCEPTANCE.overallTarget);
  });

  it("sources without claims → overall 0 + quality gate message (no fake 48%)", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [],
      sources: [ONS, BBC, FT],
      finalAnswerText: "We found some pages but could not extract claims.",
    });
    expect(report.overall).toBe(0);
    expect(report.accepted).toBe(false);
    expect(report.hardGateFailures.length).toBeGreaterThan(0);
    expect(report.hardGateFailures[0]!.message).toMatch(/Quality gate failed/i);
    expect(report.limitations.some((l) => /Quality gate failed/i.test(l))).toBe(true);
    expect(customerQualitySummary(report)).toMatch(/Quality gate failed/i);
    // Must not invent a mid-band percentage like 48%.
    expect(report.overall).not.toBe(48);
    expect(customerQualitySummary(report)).not.toMatch(/48%/);
  });

  it("variance across fixtures — not all pass >=90", () => {
    const excellent = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "UK SME AI adoption is rising according to ONS survey data.",
          sourceUrl: ONS.url,
          evidenceExcerpt: "ONS survey data shows rising AI adoption among UK SMEs",
          claimKind: "OFFICIAL",
          confidence: 0.95,
        },
        {
          claim: "BBC reports skills remain a barrier.",
          sourceUrl: BBC.url,
          evidenceExcerpt: "skills remain a barrier for smaller firms",
          claimKind: "OBSERVATION",
          confidence: 0.85,
        },
        {
          claim: "FT notes mid-market copilots.",
          sourceUrl: FT.url,
          evidenceExcerpt: "mid-market firms investing in copilots",
          claimKind: "OBSERVATION",
          confidence: 0.8,
        },
      ],
      sources: [ONS, BBC, FT],
      finalAnswerText:
        "UK SME AI adoption is rising. ONS survey data and BBC/FT reporting show skills barriers remain while mid-market firms invest in copilots.",
      gaps: ["Survey years differ slightly."],
    });

    const blogOnly = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "Buy our AI stack tomorrow.",
          sourceUrl: BLOG.url,
          evidenceExcerpt: "buy our AI stack tomorrow",
          claimKind: "RECOMMENDATION",
        },
      ],
      sources: [BLOG],
      finalAnswerText: "Buy our AI stack tomorrow for UK SMEs.",
    });

    const fabricated = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "Exactly 99% of UK SMEs use AI tomorrow.",
          sourceUrl: "https://example.com/fake",
          claimKind: "OFFICIAL",
        },
      ],
      sources: [BLOG],
      finalAnswerText: "Exactly 99% of UK SMEs use AI tomorrow.",
    });

    const wrongIntent = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [
        {
          claim: "Viral hooks and reels are trending.",
          sourceUrl: BBC.url,
          evidenceExcerpt: "viral hooks",
          claimKind: "OBSERVATION",
        },
      ],
      sources: [BBC],
      finalAnswerText: "Viral talk about hooks and formats for trending posts on reels.",
    });

    const noClaims = scoreResearchQuality({
      originalUserPrompt: PROMPT,
      researchTopic: PROMPT,
      claims: [],
      sources: [ONS],
      finalAnswerText: "Sources only.",
    });

    const scores = [
      excellent.overall,
      blogOnly.overall,
      fabricated.overall,
      wrongIntent.overall,
      noClaims.overall,
    ];
    expect(new Set(scores).size).toBeGreaterThanOrEqual(3);
    expect(scores.every((s) => s >= 90)).toBe(false);
    expect([blogOnly, fabricated, wrongIntent, noClaims].every((r) => r.accepted)).toBe(false);
    expect(noClaims.overall).toBe(0);
  });
});
