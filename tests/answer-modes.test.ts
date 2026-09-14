import { describe, expect, it, vi } from "vitest";
import { planAgentRunDeterministic } from "@/agents/supervisor/plan";
import {
  answerModeOutputSchema,
  attachApprovalProposals,
  computeHintsForAnswerMode,
  detectAnswerModeFromLanguage,
  isModeShapedOutput,
  shapeFinalOutputForMode,
  shouldSuppressBusinessClarification,
  type AskBusinessContext,
} from "@/services/answer-modes";

vi.mock("@/services/automation-os", () => ({
  createApprovalRequest: vi.fn(async () => "apr_test_1"),
}));

import { createApprovalRequest } from "@/services/automation-os";

const sampleResearchRaw = {
  researchJobId: "rj_1",
  shortAnswer: "Clinics are adopting AI booking this quarter.",
  summary: "Market interest is rising among mid-size clinics.",
  brief: "Longer brief with sources and implications.",
  claims: [
    {
      claim: "AI booking demos grew 40% YoY",
      sourceUrl: "https://example.com/a",
      evidenceExcerpt: "growth cited in report",
    },
  ],
  findings: [
    {
      claim: "AI booking demos grew 40% YoY",
      sourceUrl: "https://example.com/a",
    },
  ],
  sources: [{ url: "https://example.com/a", title: "Report", platform: "web" }],
  contentHooks: ["Show a 15s booking demo"],
  gaps: ["Pricing still opaque"],
  contradictions: [{ description: "Vendor claims conflict", sourceUrls: ["https://example.com/a"] }],
  nextBigThings: [
    {
      prediction: "Short-form booking demos win",
      whyNow: "Algorithm favors demos",
      howToRideIt: "Ship a reel this week",
      confidence: "medium",
    },
  ],
};

describe("answer mode schemas", () => {
  it("validates all four mode schemas", () => {
    const quick = shapeFinalOutputForMode("QUICK", sampleResearchRaw);
    const executive = shapeFinalOutputForMode("EXECUTIVE", sampleResearchRaw);
    const action = shapeFinalOutputForMode("ACTION", sampleResearchRaw);
    const deep = shapeFinalOutputForMode("DEEP", sampleResearchRaw);

    expect(answerModeOutputSchema.parse(quick).mode).toBe("quick");
    expect(answerModeOutputSchema.parse(executive).mode).toBe("executive");
    expect(answerModeOutputSchema.parse(action).mode).toBe("action");
    expect(answerModeOutputSchema.parse(deep).mode).toBe("deep");
    expect(quick?.findings?.[0]?.sourceUrl).toBe("https://example.com/a");
    expect(quick?.sources?.[0]?.url).toBe("https://example.com/a");
    expect(executive?.findings?.[0]?.sourceUrl).toBe("https://example.com/a");
    expect(action?.sources?.[0]?.url).toBe("https://example.com/a");
    expect(action?.actions[0]?.sourceUrl).toBe("https://example.com/a");
    expect(deep?.findings?.[0]?.sourceUrl).toBe("https://example.com/a");
  });
});

describe("format intent detection", () => {
  it("detects modes conservatively from language", () => {
    expect(detectAnswerModeFromLanguage("give me a quick answer on competitors")).toBe("QUICK");
    expect(detectAnswerModeFromLanguage("summarise this for management")).toBe("EXECUTIVE");
    expect(detectAnswerModeFromLanguage("tell me exactly what to do next")).toBe("ACTION");
    expect(detectAnswerModeFromLanguage("give me a detailed report on the market")).toBe("DEEP");
    expect(detectAnswerModeFromLanguage("research plant hire pricing")).toBeNull();
  });

  it("skips format clarification when answerMode is explicit", () => {
    const result = planAgentRunDeterministic("Research plant hire pricing in the UK", {
      organisationId: "org_1",
      answerMode: "QUICK",
    });
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.steps[0]?.agentName).toBe("research");
  });

  it("defaults sourced research without a format pick to a Quick FAST scan", () => {
    const result = planAgentRunDeterministic("Research plant hire pricing in the UK", {
      organisationId: "org_1",
    });
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0]?.agentName).toBe("research");
    expect((result.plan.steps[0]?.input as { depth?: string }).depth).toBe("FAST");
  });
});

describe("context resolver suppresses redundant clarification", () => {
  it("suppresses industry asks when products/company are known", () => {
    const ctx: AskBusinessContext = {
      plan: { items: [], maxTokens: 3000, estimatedTokens: 0, truncated: false },
      knownFacts: ["company:Acme", "products:Widgets"],
      hasCompany: true,
      hasProducts: true,
      hasAudience: false,
      hasCompetitors: false,
      hasGoals: false,
    };
    expect(
      shouldSuppressBusinessClarification("What industry are you in?", ctx),
    ).toBe(true);
    expect(
      shouldSuppressBusinessClarification("How would you like this answered?", ctx),
    ).toBe(false);
  });
});

describe("mode → compute governor mapping", () => {
  it("maps modes into existing governor controls", () => {
    expect(computeHintsForAnswerMode("QUICK")).toMatchObject({
      answerMode: "QUICK",
      verificationBudget: "FAST",
      complexity: "LOW",
      preferCache: true,
    });
    expect(computeHintsForAnswerMode("EXECUTIVE").complexity).toBe("MEDIUM");
    expect(computeHintsForAnswerMode("ACTION", "LOW").complexity).toBe("MEDIUM");
    expect(computeHintsForAnswerMode("ACTION", "HIGH").complexity).toBe("HIGH");
    expect(computeHintsForAnswerMode("DEEP")).toMatchObject({
      verificationBudget: "DEEP",
      complexity: "CRITICAL",
    });
  });
});

describe("ACTION proposals", () => {
  it("creates ApprovalRequest proposals instead of executing", async () => {
    const shaped = shapeFinalOutputForMode("ACTION", sampleResearchRaw);
    expect(shaped?.mode).toBe("action");
    if (!shaped || shaped.mode !== "action") return;

    const withApprovals = await attachApprovalProposals({
      organisationId: "org_1",
      agentRunId: "run_1",
      answerMode: "ACTION",
      output: shaped,
    });

    expect(createApprovalRequest).toHaveBeenCalled();
    expect(withApprovals.actions.some((a) => a.approvalRequestId === "apr_test_1")).toBe(true);
    for (const call of vi.mocked(createApprovalRequest).mock.calls) {
      expect(call[0]?.payload).toMatchObject({ autoExecute: false });
    }
  });
});

describe("legacy AgentRun output rendering", () => {
  it("does not treat old research shapes as mode-shaped", () => {
    expect(isModeShapedOutput(sampleResearchRaw)).toBe(false);
    expect(
      isModeShapedOutput({
        summary: "Old brief",
        claims: [{ claim: "x", sourceUrl: "https://example.com" }],
      }),
    ).toBe(false);
    expect(isModeShapedOutput({ mode: "quick", answer: "Yes" })).toBe(true);
  });
});
