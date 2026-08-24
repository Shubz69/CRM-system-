/**
 * Phase 14F — Intelligence Quality unit tests (deterministic gates).
 * Maturity: WORKING — not LIVE_E2E.
 */

import { describe, expect, it } from "vitest";
import {
  applyQualityGate,
  budgetThresholds,
  runVerificationPipeline,
} from "@/services/intelligence-quality";

describe("intelligence-quality gate", () => {
  it("returns INSUFFICIENT_EVIDENCE when no supporting evidence", () => {
    const result = runVerificationPipeline({ findings: [], budget: "STANDARD" });
    expect(result.gateStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.calibrationNote).toBe("transparent_heuristics_not_calibrated_percentages");
  });

  it("returns CONFLICTED when contradicting outweighs supporting", () => {
    const now = new Date();
    const result = runVerificationPipeline({
      budget: "STANDARD",
      findings: [
        {
          claimText: "Product X grew 40% MoM",
          sourceUrl: "https://a.example/1",
          providerKey: "web",
          retrievedAt: now,
          supports: true,
        },
        {
          claimText: "Product X grew 40% MoM",
          sourceUrl: "https://b.example/1",
          providerKey: "web",
          retrievedAt: now,
          supports: false,
        },
        {
          claimText: "Product X grew 40% MoM",
          sourceUrl: "https://c.example/1",
          providerKey: "web",
          retrievedAt: now,
          supports: false,
        },
      ],
    });
    expect(result.gateStatus).toBe("CONFLICTED");
  });

  it("returns STALE for old evidence under STANDARD", () => {
    const stale = new Date(Date.now() - 200 * 86_400_000);
    const result = runVerificationPipeline({
      budget: "STANDARD",
      findings: [
        {
          claimText: "Market demand is rising in SaaS CRM",
          sourceUrl: "https://news.example/old",
          providerKey: "tavily",
          retrievedAt: stale,
          publishedAt: stale,
          supports: true,
          authorityTier: "indexed_web",
        },
      ],
    });
    expect(result.gateStatus).toBe("STALE");
  });

  it("can PASS under STANDARD with independent corroboration", () => {
    const now = new Date();
    const result = runVerificationPipeline({
      budget: "STANDARD",
      findings: [
        {
          claimText: "LinkedIn organic reach is improving for B2B creators",
          sourceUrl: "https://linkedin.com/posts/1",
          providerKey: "linkedin",
          retrievedAt: now,
          supports: true,
          authorityTier: "connected_api",
          sampleSize: 50,
        },
        {
          claimText: "LinkedIn organic reach is improving for B2B creators",
          sourceUrl: "https://research.example/report",
          providerKey: "tavily",
          retrievedAt: now,
          supports: true,
          authorityTier: "indexed_web",
          sampleSize: 50,
        },
      ],
    });
    expect(result.gateStatus).toBe("PASSED");
  });

  it("uses stricter thresholds for MISSION_CRITICAL vs FAST", () => {
    expect(budgetThresholds("MISSION_CRITICAL").passAvg).toBeGreaterThan(
      budgetThresholds("FAST").passAvg,
    );
    expect(budgetThresholds("MISSION_CRITICAL").minSupport).toBeGreaterThan(
      budgetThresholds("FAST").minSupport,
    );

    const now = new Date();
    const thin = [
      {
        claimText: "Single thin claim",
        sourceUrl: "https://only.example/1",
        providerKey: "web",
        retrievedAt: now,
        supports: true as const,
        authorityTier: "indexed_web" as const,
      },
    ];
    const fast = runVerificationPipeline({ findings: thin, budget: "FAST" });
    const critical = runVerificationPipeline({ findings: thin, budget: "MISSION_CRITICAL" });
    expect(fast.gateStatus === "PASSED" || fast.gateStatus === "NEEDS_MORE_RESEARCH").toBe(true);
    expect(critical.gateStatus).not.toBe("PASSED");
  });

  it("does not invent calibrated percentage confidence", () => {
    const result = runVerificationPipeline({
      findings: [],
      budget: "STANDARD",
      llmCriticNotes: "I am 97% confident this is excellent.",
    });
    expect(result.gateStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.agents.critic.gateOverrideAttempted).toBe(false);
    expect(result.criticNotes).toContain("97%");
    expect(result).not.toHaveProperty("confidencePercent");

    const gate = applyQualityGate({
      dimensions: {
        authority: 0.8,
        freshness: 0.8,
        corroboration: 0.75,
        independence: 0.8,
        audienceRelevance: 0.6,
        platformRelevance: 0.6,
        geoRelevance: 0.5,
        sampleSize: 0.7,
        socialQuality: 0.5,
        survivorshipRisk: 0.2,
        negativeEvidence: 0,
      },
      budget: "STANDARD",
      contradictingCount: 0,
      supportingCount: 2,
    });
    expect(gate).toBe("PASSED");
    expect(typeof gate).toBe("string");
  });
});
