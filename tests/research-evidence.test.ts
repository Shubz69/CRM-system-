import { describe, expect, it } from "vitest";
import {
  computeFreshnessScore,
  hashSourceContent,
  isExcerptGrounded,
  normalizeEvidenceText,
  parseClaimKind,
} from "@/services/research-evidence";
import { buildIntegrationCapabilityMatrix } from "@/services/research-source-registry";
import { ResearchClaimKind } from "@prisma/client";

describe("research evidence helpers", () => {
  it("normalises and hashes content stably", () => {
    const a = hashSourceContent("Hello, World!\n\nFOO");
    const b = hashSourceContent("hello world foo");
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(normalizeEvidenceText("A  B")).toBe("a b");
  });

  it("scores freshness from publishedAt age", () => {
    const now = new Date("2026-08-22T12:00:00Z");
    expect(computeFreshnessScore(new Date("2026-08-20T12:00:00Z"), now)).toBe(1);
    expect(computeFreshnessScore(new Date("2026-08-01T12:00:00Z"), now)).toBe(0.75);
    expect(computeFreshnessScore(new Date("2026-06-01T12:00:00Z"), now)).toBe(0.5);
    expect(computeFreshnessScore(null, now)).toBeNull();
  });

  it("parses claim kinds", () => {
    expect(parseClaimKind("observation")).toBe(ResearchClaimKind.OBSERVATION);
    expect(parseClaimKind("nope")).toBe(ResearchClaimKind.UNKNOWN);
  });

  it("grounds when excerpt is in source body", () => {
    const body = "Short vertical clips with a clear hook won more reach this week.";
    const ok = isExcerptGrounded({
      claim: "Short clips won more reach",
      evidenceExcerpt: "clear hook won more reach this week",
      sourceContent: body,
    });
    expect(ok.grounded).toBe(true);
  });

  it("rejects invented excerpts", () => {
    const bad = isExcerptGrounded({
      claim: "Aliens boosted CTR",
      evidenceExcerpt: "aliens boosted ctr overnight",
      sourceContent: "Short vertical clips with a clear hook won more reach this week.",
    });
    expect(bad.grounded).toBe(false);
  });
});

describe("integration capability matrix", () => {
  it("returns platforms without inventing configured status blindly", () => {
    const matrix = buildIntegrationCapabilityMatrix();
    expect(matrix.platforms.length).toBeGreaterThan(5);
    expect(matrix.generatedAt).toBeTruthy();
    const youtube = matrix.platforms.find((p) => p.platform === "youtube");
    expect(youtube).toBeTruthy();
    expect(["configured", "requires_credentials"]).toContain(
      youtube!.capabilities.search_public,
    );
  });
});
