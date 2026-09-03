import { describe, expect, it } from "vitest";
import {
  assertExpectedOrganisation,
  WorkspaceChangedError,
} from "@/lib/workspace-mutation-guard";
import { pickActiveWorkspace } from "@/services/active-workspace";
import { planAgentRunDeterministic, classifyResearchIntent } from "@/agents/supervisor/plan";
import { scoreResearchQuality, customerQualitySummary } from "@/services/research-quality";
import { ASK_OUTCOME_CARDS } from "@/lib/navigation";

describe("workspace expected-organisation guard", () => {
  it("allows matching expected org", () => {
    expect(() => assertExpectedOrganisation("org_a", "org_a")).not.toThrow();
  });

  it("allows missing expected org (legacy clients)", () => {
    expect(() => assertExpectedOrganisation("org_a", null)).not.toThrow();
  });

  it("rejects mismatch with WORKSPACE_CHANGED", () => {
    expect(() => assertExpectedOrganisation("org_a", "org_b")).toThrow(WorkspaceChangedError);
    try {
      assertExpectedOrganisation("org_a", "org_b");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkspaceChangedError);
      expect((e as WorkspaceChangedError).code).toBe("WORKSPACE_CHANGED");
    }
  });
});

describe("active workspace pick prefers explicit selection", () => {
  const memberships = [
    {
      organisationId: "platform",
      role: "SUPER_ADMIN" as const,
      organisation: {
        id: "platform",
        name: "Agent Desk Platform",
        isPlatform: true,
        deletedAt: null,
        status: "ACTIVE",
      },
    },
    {
      organisationId: "qa",
      role: "OWNER" as const,
      organisation: {
        id: "qa",
        name: "Automated QA",
        isPlatform: false,
        deletedAt: null,
        status: "ACTIVE",
      },
    },
  ];

  it("honours preferred org in both directions", () => {
    expect(pickActiveWorkspace(memberships, "qa")?.organisationId).toBe("qa");
    expect(pickActiveWorkspace(memberships, "platform")?.organisationId).toBe("platform");
    expect(pickActiveWorkspace(memberships, "qa")?.organisationId).toBe("qa");
  });
});

describe("pipeline Ask routing uses internal CRM", () => {
  it("classifies summarise-my-pipeline as crm_internal", () => {
    expect(classifyResearchIntent("Summarise my pipeline and flag stalled deals")).toBe(
      "crm_internal",
    );
  });

  it("plans crm_desk for pipeline shortcut text (not summarise/echo)", () => {
    const plan = planAgentRunDeterministic("Summarise my pipeline and flag stalled deals");
    expect(plan.kind).toBe("plan");
    if (plan.kind !== "plan") return;
    expect(plan.plan.steps[0]?.agentName).toBe("crm_desk");
    expect(plan.plan.steps.some((s) => s.agentName === "research")).toBe(false);
    expect(plan.plan.steps.some((s) => s.agentName === "echo")).toBe(false);
  });

  it("pipeline outcome card has a complete prefill (one-click runnable)", () => {
    const card = ASK_OUTCOME_CARDS.find((c) => c.id === "pipeline");
    expect(card?.prefill).toBeTruthy();
    expect(/\s$|:\s*$/.test(card!.prefill!)).toBe(false);
  });
});

describe("research quality variance and honesty", () => {
  const basePrompt = "Research UK SME AI adoption rates with sources";

  it("returns Quality gate failed when not numerically evaluable", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: basePrompt,
      researchTopic: basePrompt,
      claims: [],
      sources: [],
      finalAnswerText: "Something happened.",
    });
    expect(report.overall).toBe(0);
    expect(report.accepted).toBe(false);
    expect(customerQualitySummary(report)).toMatch(/Quality gate failed/i);
  });

  it("scores excellent / mixed / poor / wrong-intent differently", () => {
    const excellent = scoreResearchQuality({
      originalUserPrompt: basePrompt,
      researchTopic: basePrompt,
      claims: [
        {
          claim: "UK SME AI adoption is rising according to ONS survey data.",
          sourceUrl: "https://www.ons.gov.uk/business",
          evidenceExcerpt: "ONS survey data shows rising AI adoption among UK SMEs in 2025",
          claimKind: "OFFICIAL",
          confidence: 0.95,
        },
        {
          claim: "BBC reports skills remain a barrier.",
          sourceUrl: "https://www.bbc.com/news/tech",
          evidenceExcerpt: "skills remain a barrier for smaller firms",
          claimKind: "OBSERVATION",
          confidence: 0.85,
        },
        {
          claim: "FT notes mid-market copilots.",
          sourceUrl: "https://www.ft.com/content/x",
          evidenceExcerpt: "mid-market firms investing in copilots",
          claimKind: "OBSERVATION",
          confidence: 0.8,
        },
      ],
      sources: [
        {
          url: "https://www.ons.gov.uk/business",
          title: "ONS",
          publishedAt: new Date().toISOString(),
          freshnessScore: 0.95,
        },
        {
          url: "https://www.bbc.com/news/tech",
          title: "BBC",
          publishedAt: new Date().toISOString(),
          freshnessScore: 0.9,
        },
        {
          url: "https://www.ft.com/content/x",
          title: "FT",
          publishedAt: new Date().toISOString(),
          freshnessScore: 0.85,
        },
      ],
      finalAnswerText:
        "UK SME AI adoption is rising. ONS survey data and BBC/FT reporting show skills barriers remain while mid-market firms invest in copilots.",
      gaps: ["Survey years differ slightly."],
    });

    const poor = scoreResearchQuality({
      originalUserPrompt: basePrompt,
      researchTopic: basePrompt,
      claims: [
        {
          claim: "Exactly 99% of UK SMEs use AI tomorrow.",
          sourceUrl: "https://example.com/fake",
          claimKind: "OFFICIAL",
        },
      ],
      sources: [{ url: "https://medium.com/random-blog", title: "Blog" }],
      finalAnswerText: "Exactly 99% of UK SMEs use AI tomorrow.",
    });

    const wrongIntent = scoreResearchQuality({
      originalUserPrompt: basePrompt,
      researchTopic: basePrompt,
      claims: [
        {
          claim: "Viral hooks and reels are trending for creators.",
          sourceUrl: "https://www.bbc.com/news/tech",
          evidenceExcerpt: "viral hooks",
          claimKind: "OBSERVATION",
        },
      ],
      sources: [
        {
          url: "https://www.bbc.com/news/tech",
          title: "BBC",
          publishedAt: new Date().toISOString(),
        },
      ],
      finalAnswerText: "Viral talk about hooks and formats for trending posts on reels.",
    });

    const ukGdprWeak = scoreResearchQuality({
      originalUserPrompt: "What does UK GDPR require for marketing consent?",
      researchTopic: "What does UK GDPR require for marketing consent?",
      claims: [
        {
          claim: "You can email anyone if you want.",
          sourceUrl: "https://medium.com/privacy-takes",
          claimKind: "RECOMMENDATION",
        },
      ],
      sources: [{ url: "https://medium.com/privacy-takes", title: "Blog" }],
      finalAnswerText: "You can email anyone if you want.",
    });

    const ukGdprStrong = scoreResearchQuality({
      originalUserPrompt: "What does UK GDPR require for marketing consent?",
      researchTopic: "What does UK GDPR require for marketing consent?",
      claims: [
        {
          claim: "ICO guidance requires a lawful basis such as consent or legitimate interests.",
          sourceUrl: "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/",
          evidenceExcerpt: "lawful basis such as consent or legitimate interests",
          claimKind: "OFFICIAL",
          confidence: 0.95,
        },
        {
          claim: "PECR rules sit alongside UK GDPR for electronic marketing.",
          sourceUrl: "https://www.legislation.gov.uk/uksi/2003/2426",
          evidenceExcerpt: "Privacy and Electronic Communications",
          claimKind: "OFFICIAL",
          confidence: 0.9,
        },
      ],
      sources: [
        {
          url: "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/",
          title: "ICO",
          publishedAt: new Date().toISOString(),
          freshnessScore: 0.9,
        },
        {
          url: "https://www.legislation.gov.uk/uksi/2003/2426",
          title: "legislation.gov.uk",
          publishedAt: new Date().toISOString(),
          freshnessScore: 0.7,
        },
      ],
      finalAnswerText:
        "ICO guidance requires a lawful basis such as consent or legitimate interests; PECR rules on legislation.gov.uk sit alongside UK GDPR for electronic marketing.",
      gaps: ["Always check the latest ICO pages for your channel."],
    });

    expect(excellent.overall).toBeGreaterThan(poor.overall);
    expect(excellent.overall).not.toBe(wrongIntent.overall);
    expect(poor.overall).not.toBe(wrongIntent.overall);
    expect(ukGdprStrong.breakdown.sourceQuality).toBeGreaterThan(
      ukGdprWeak.breakdown.sourceQuality,
    );
    expect(ukGdprWeak.accepted).toBe(false);
    expect(ukGdprWeak.confidenceLabel).not.toBe("High confidence");
    // Must not collapse unrelated fixtures to the same fake mid score.
    const scores = [excellent.overall, poor.overall, wrongIntent.overall, ukGdprWeak.overall];
    expect(new Set(scores).size).toBeGreaterThanOrEqual(3);
  });
});
