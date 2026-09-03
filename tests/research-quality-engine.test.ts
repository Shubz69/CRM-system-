import { describe, expect, it } from "vitest";
import { scoreResearchQuality, RESEARCH_ACCEPTANCE } from "@/services/research-quality";
import { classifyResearchIntent } from "@/agents/supervisor/plan";
import { stripClarificationMetadata, sanitizeResearchTopic } from "@/lib/agent-request-sanitize";
import { buildProspectFitDimensions } from "@/services/social-prospecting/quality";
import { normalizeContentPlatform, publishNetworkForContentPlatform } from "@/lib/content-platform";
import { validateSocialVideoDraft } from "@/services/publishing/video-validation";

const GOOD_SOURCES = [
  {
    url: "https://www.ons.gov.uk/businessindustryandtrade/abc",
    title: "ONS — Business AI adoption",
    platform: "web",
    publishedAt: new Date().toISOString(),
    freshnessScore: 0.9,
  },
  {
    url: "https://www.bbc.com/news/technology-ai-sme",
    title: "BBC — UK SMEs and AI",
    platform: "web",
    publishedAt: new Date().toISOString(),
    freshnessScore: 0.85,
  },
  {
    url: "https://www.ft.com/content/ai-sme-uk",
    title: "FT — AI adoption among UK firms",
    platform: "web",
    publishedAt: new Date().toISOString(),
    freshnessScore: 0.8,
  },
];

describe("research quality engine", () => {
  it("scores strong grounded research highly and accepts when gates pass", () => {
    const prompt = "Research UK SME AI adoption rates with sources";
    const report = scoreResearchQuality({
      originalUserPrompt: prompt,
      researchTopic: prompt,
      businessSpecific: false,
      claims: [
        {
          claim: "UK SME AI adoption is rising according to ONS survey data.",
          sourceUrl: GOOD_SOURCES[0]!.url,
          evidenceExcerpt: "ONS survey data shows rising AI adoption among UK SMEs",
          claimKind: "OFFICIAL",
          confidence: 0.9,
        },
        {
          claim: "BBC reports cost and skills remain barriers for smaller firms.",
          sourceUrl: GOOD_SOURCES[1]!.url,
          evidenceExcerpt: "cost and skills remain barriers for smaller firms",
          claimKind: "OBSERVATION",
          confidence: 0.85,
        },
        {
          claim: "FT notes mid-market firms investing in copilots.",
          sourceUrl: GOOD_SOURCES[2]!.url,
          evidenceExcerpt: "mid-market firms investing in copilots",
          claimKind: "OBSERVATION",
          confidence: 0.8,
        },
      ],
      sources: GOOD_SOURCES,
      finalAnswerText:
        "UK SME AI adoption is rising. ONS survey data and BBC/FT reporting show cost and skills barriers remain for smaller firms while mid-market firms invest in copilots.",
      gaps: ["Exact percentage varies by survey year."],
      contradictions: [],
    });
    expect(report.breakdown.promptFidelity).toBeGreaterThanOrEqual(RESEARCH_ACCEPTANCE.promptFidelityMin);
    expect(report.breakdown.factualAccuracy).toBeGreaterThanOrEqual(RESEARCH_ACCEPTANCE.factualAccuracyMin);
    expect(report.overall).toBeGreaterThanOrEqual(80);
    expect(report.hardGateFailures.some((f) => f.code === "FABRICATED_URL")).toBe(false);
  });

  it("hard-fails fabricated URLs and unsupported claims", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: "UK SME AI adoption",
      researchTopic: "UK SME AI adoption",
      claims: [
        {
          claim: "Exactly 87.3% of UK SMEs use AI.",
          sourceUrl: "https://example.com/fake-stat",
          claimKind: "OFFICIAL",
        },
      ],
      sources: [{ url: "https://www.ons.gov.uk/real", title: "ONS" }],
      finalAnswerText: "Exactly 87.3% of UK SMEs use AI per Example.",
    });
    expect(report.accepted).toBe(false);
    expect(report.hardGateFailures.some((f) => f.code === "FABRICATED_URL")).toBe(true);
  });

  it("hard-fails previous-run / clarification contamination in topic", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: "UK SME AI adoption",
      researchTopic: "UK SME AI adoption\n\n[User chose: Research this topic with sources]",
      claims: [],
      sources: GOOD_SOURCES,
      finalAnswerText: "Viral talk about hooks and reels for creators.",
    });
    expect(report.accepted).toBe(false);
    expect(
      report.hardGateFailures.some(
        (f) => f.code === "CROSS_RUN_CONTAMINATION" || f.code === "WRONG_INTENT",
      ),
    ).toBe(true);
  });

  it("penalises wrong geography / ignored constraints", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: "What is AI adoption among UK SMEs in 2025?",
      researchTopic: "AI adoption",
      claims: [
        {
          claim: "US enterprises lead AI spend.",
          sourceUrl: GOOD_SOURCES[1]!.url,
          evidenceExcerpt: "US enterprises lead AI spend",
        },
      ],
      sources: GOOD_SOURCES,
      finalAnswerText: "US enterprises lead AI spend across Fortune 500 accounts.",
    });
    expect(report.breakdown.promptFidelity).toBeLessThan(95);
    expect(report.accepted).toBe(false);
  });

  it("penalises weak single-source packs without uncertainty disclosure", () => {
    const url = GOOD_SOURCES[0]!.url;
    const report = scoreResearchQuality({
      originalUserPrompt: "Research UK SME AI adoption",
      researchTopic: "Research UK SME AI adoption",
      claims: [
        { claim: "Claim one", sourceUrl: url, evidenceExcerpt: "excerpt one here" },
        { claim: "Claim two", sourceUrl: url, evidenceExcerpt: "excerpt two here" },
        { claim: "Claim three", sourceUrl: url, evidenceExcerpt: "excerpt three here" },
      ],
      sources: [GOOD_SOURCES[0]!],
      finalAnswerText: "UK SME AI adoption notes from one source only.",
      gaps: [],
    });
    expect(report.breakdown.crossVerification).toBeLessThan(70);
    expect(report.breakdown.uncertainty).toBeLessThan(60);
  });

  it("flags fabricated named people not in sources", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: "UK SME AI adoption",
      researchTopic: "UK SME AI adoption",
      claims: [
        {
          claim: "Experts comment",
          sourceUrl: GOOD_SOURCES[0]!.url,
          evidenceExcerpt: "Experts comment on adoption",
        },
      ],
      sources: GOOD_SOURCES,
      finalAnswerText: "According to Amelia Quigley-Barnes, UK SMEs adopt AI rapidly.",
    });
    expect(report.hardGateFailures.some((f) => f.code === "FABRICATED_ENTITY")).toBe(true);
    expect(report.accepted).toBe(false);
  });
});

describe("ask prompt isolation helpers", () => {
  it("strips User chose metadata from topics", () => {
    const raw = "UK SME AI adoption\n\n[User chose: Research this topic with sources]";
    expect(stripClarificationMetadata(raw)).toBe("UK SME AI adoption");
    expect(sanitizeResearchTopic(raw)).toBe("UK SME AI adoption");
  });

  it("classifies business factual vs social content intents", () => {
    expect(classifyResearchIntent("What is AI adoption among UK SMEs?")).toBe("business_factual");
    expect(classifyResearchIntent("UK SME AI adoption statistics 2025")).toBe("business_factual");
    expect(classifyResearchIntent("Compare TAM and competitors in enterprise software")).toBe("market");
    expect(classifyResearchIntent("What viral TikTok hooks are trending this week?")).toBe(
      "social_content",
    );
  });
});

describe("content platforms + video validation", () => {
  it("normalizes youtube short and tiktok platforms", () => {
    expect(normalizeContentPlatform("YouTube Short")).toBe("youtube_short");
    expect(normalizeContentPlatform("instagramLinkedIn")).toBe(null);
    expect(publishNetworkForContentPlatform("youtube_short")).toBe("YOUTUBE");
    expect(publishNetworkForContentPlatform("tiktok")).toBe("TIKTOK");
  });

  it("validates short-form video drafts without inventing fake success", () => {
    expect(
      validateSocialVideoDraft({
        platform: "youtube_short",
        title: "Demo short",
        socialConnectionId: "sc_1",
        mimeType: "video/mp4",
        durationSeconds: 45,
        width: 1080,
        height: 1920,
      }).ok,
    ).toBe(true);
    expect(
      validateSocialVideoDraft({
        platform: "tiktok",
        title: "Clip",
        socialConnectionId: null,
        mimeType: "image/png",
      }).ok,
    ).toBe(false);
  });
});

describe("prospect fit dimensions", () => {
  it("never treats missing evidence as 100%", () => {
    const dims = buildProspectFitDimensions({
      identityConfidence: 0.6,
      roleConfidence: 0,
      locationConfidence: 0,
      companyAssociationConfidence: 0,
      fitScore: 0.5,
    });
    expect(dims.roleMatch).toBe(0);
    expect(dims.geographyMatch).toBe(0);
    expect(dims.overallFit).toBeLessThan(100);
    expect(dims.identityConfidence).toBeLessThanOrEqual(95);
  });
});
