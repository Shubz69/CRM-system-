/**
 * Round 7C — RQS grounded-claim handoff fixtures (A–I) + score variance.
 * Proves Deep-shaped findings feed RQS even when analyst enrichment aborts.
 */
import { describe, expect, it } from "vitest";
import {
  scoreResearchQuality,
  extractCanonicalGroundedClaims,
  toScoreResearchClaims,
  countLinkedGroundedClaims,
} from "@/services/research-quality";
import { shapeFinalOutputForMode } from "@/services/answer-modes";

const ICO = "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/";
const GOV = "https://www.gov.uk/data-protection";
const LEG = "https://www.legislation.gov.uk/ukpga/2018/12/contents";
const BLOG = "https://random-blog.example/gdpr-tips";

const AUTH_SOURCES = [
  { url: ICO, title: "ICO UK GDPR", platform: "web" },
  { url: GOV, title: "GOV.UK data protection", platform: "web" },
  { url: LEG, title: "Data Protection Act 2018", platform: "web" },
];

function fifteenGroundedFindings() {
  const urls = [ICO, GOV, LEG];
  return Array.from({ length: 15 }, (_, i) => ({
    claim: `UK GDPR CRM contact storage requirement finding ${i + 1}: controllers must have a lawful basis for processing personal data.`,
    sourceUrl: urls[i % urls.length]!,
    evidenceExcerpt: `Lawful basis for processing personal data is required under UK GDPR for CRM contact storage claim ${i + 1}.`,
    claimKind: i % 3 === 0 ? "OFFICIAL" : "OBSERVATION",
    confidence: 0.72 + (i % 5) * 0.02,
  }));
}

function scoreFromDeepShaped(input: {
  findings?: ReturnType<typeof fifteenGroundedFindings>;
  claims?: ReturnType<typeof fifteenGroundedFindings>;
  sources?: typeof AUTH_SOURCES;
  gaps?: string[];
  analystEnrichmentFailed?: boolean;
  prompt?: string;
  finalAnswerText?: string;
}) {
  const raw = {
    shortAnswer: input.finalAnswerText || "UK GDPR requires a lawful basis to store CRM contacts.",
    summary: input.finalAnswerText || "Authoritative UK GDPR CRM storage overview.",
    brief: input.finalAnswerText || "See findings.",
    claims: input.claims,
    findings: input.findings,
    sources: input.sources ?? AUTH_SOURCES,
    gaps: input.gaps ?? [],
    contradictions: [],
    analystEnrichmentFailed: input.analystEnrichmentFailed,
  };
  const shaped = shapeFinalOutputForMode("DEEP", raw) as Record<string, unknown>;
  const grounded = extractCanonicalGroundedClaims(shaped, {
    allowedSourceUrls: (shaped.sources as Array<{ url: string }> | undefined)?.map((s) => s.url),
  });
  const claims = toScoreResearchClaims(grounded);
  const report = scoreResearchQuality({
    originalUserPrompt:
      input.prompt ||
      "Research the current UK GDPR requirements for storing customer contact details in a CRM. Prioritise authoritative UK sources.",
    researchTopic:
      input.prompt ||
      "Research the current UK GDPR requirements for storing customer contact details in a CRM. Prioritise authoritative UK sources.",
    answerMode: "DEEP",
    businessSpecific: false,
    organisationId: "org_test",
    outputOrganisationId: "org_test",
    claims,
    sources: (shaped.sources as Array<{ url: string; title?: string; platform?: string }>) || [],
    finalAnswerText: String(shaped.executiveSummary || ""),
    gaps: Array.isArray(shaped.unknowns)
      ? (shaped.unknowns as string[])
      : input.gaps || [],
  });
  return { shaped, grounded, claims, report, linked: countLinkedGroundedClaims(grounded) };
}

describe("RQS grounded-claim handoff (Round 7C)", () => {
  it("A: 15 grounded findings + analyst success → RQS sees 15 claims", () => {
    const findings = fifteenGroundedFindings();
    const { claims, linked, report } = scoreFromDeepShaped({
      claims: findings,
      findings,
    });
    expect(claims.length).toBe(15);
    expect(linked).toBe(15);
    expect(report.claimConfidences.length).toBe(15);
    expect(report.overall).toBeGreaterThan(0);
  });

  it("B: 15 grounded findings + analyst abort → RQS still sees 15 claims", () => {
    const findings = fifteenGroundedFindings();
    // Deep shape only has findings (claims dropped) — mirrors production path after reshape.
    const { claims, linked, report, shaped } = scoreFromDeepShaped({
      findings,
      claims: undefined,
      analystEnrichmentFailed: true,
      gaps: ["Structured analyst synthesis failed validation; showing grounded findings/sources only."],
    });
    expect(Array.isArray(shaped.claims)).toBe(false);
    expect(Array.isArray(shaped.findings)).toBe(true);
    expect((shaped.findings as unknown[]).length).toBe(15);
    expect(claims.length).toBe(15);
    expect(linked).toBe(15);
    expect(report.claimConfidences.length).toBe(15);
    expect(report.overall).toBeGreaterThan(0);
    // Must not be the old zero-RQS / empty-claims handoff failure.
    expect(
      report.hardGateFailures.some((f) =>
        /no verifiable claims were linked/i.test(f.message),
      ),
    ).toBe(false);
  });

  it("C: invalid source link → unlinked / not verified", () => {
    const sources = AUTH_SOURCES;
    const grounded = extractCanonicalGroundedClaims(
      {
        findings: [
          {
            claim: "Claim cites a URL never collected.",
            sourceUrl: "https://not-in-sources.example/page",
            evidenceExcerpt: "excerpt that looks real enough here",
          },
        ],
        sources,
      },
      { allowedSourceUrls: sources.map((s) => s.url) },
    );
    expect(grounded).toHaveLength(1);
    expect(grounded[0]!.supportStatus).toBe("unlinked");
    expect(countLinkedGroundedClaims(grounded)).toBe(0);
  });

  it("D: definitive claim with insufficient support → UNSUPPORTED_DEFINITIVE_CLAIM", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: "UK GDPR CRM contact storage requirements",
      researchTopic: "UK GDPR CRM contact storage requirements",
      claims: [
        {
          claim: "UK law absolutely requires encrypted CRM storage at all times with no exceptions.",
          // no sourceUrl → unsupported definitive
          claimKind: "OFFICIAL",
        },
      ],
      sources: AUTH_SOURCES,
      finalAnswerText:
        "UK law absolutely requires encrypted CRM storage at all times with no exceptions.",
    });
    expect(report.accepted).toBe(false);
    expect(
      report.hardGateFailures.some((f) => f.code === "UNSUPPORTED_DEFINITIVE_CLAIM"),
    ).toBe(true);
  });

  it("E: definitive claim with valid strong support → does NOT trigger unsupported-definitive gate", () => {
    const report = scoreResearchQuality({
      originalUserPrompt:
        "Research the current UK GDPR requirements for storing customer contact details in a CRM. Prioritise authoritative UK sources.",
      researchTopic:
        "Research the current UK GDPR requirements for storing customer contact details in a CRM. Prioritise authoritative UK sources.",
      claims: [
        {
          claim: "Controllers must identify a lawful basis before processing CRM contact data.",
          sourceUrl: ICO,
          evidenceExcerpt:
            "You must have a lawful basis in order to process personal data under the UK GDPR.",
          claimKind: "OFFICIAL",
          confidence: 0.85,
        },
        {
          claim: "The Data Protection Act 2018 sits alongside the UK GDPR.",
          sourceUrl: LEG,
          evidenceExcerpt: "Data Protection Act 2018 works with the UK GDPR framework.",
          claimKind: "OFFICIAL",
          confidence: 0.8,
        },
        {
          claim: "GOV.UK summarises data protection obligations for organisations.",
          sourceUrl: GOV,
          evidenceExcerpt: "Data protection guide for organisations in the UK.",
          claimKind: "OFFICIAL",
          confidence: 0.8,
        },
      ],
      sources: AUTH_SOURCES,
      finalAnswerText:
        "Controllers must identify a lawful basis before processing CRM contact data under UK GDPR, alongside the Data Protection Act 2018.",
      gaps: ["Exact retention periods depend on purpose."],
    });
    expect(
      report.hardGateFailures.some(
        (f) =>
          f.code === "UNSUPPORTED_DEFINITIVE_CLAIM" &&
          /no verifiable claims were linked|Claim has no traceable/i.test(f.message),
      ),
    ).toBe(false);
    expect(report.claimConfidences.length).toBe(3);
    expect(report.overall).toBeGreaterThan(0);
  });

  it("F: zero grounded findings → honest reject", () => {
    const { claims, report } = scoreFromDeepShaped({
      findings: [],
      claims: [],
      sources: AUTH_SOURCES,
    });
    expect(claims.length).toBe(0);
    expect(report.accepted).toBe(false);
    expect(report.overall).toBe(0);
    expect(
      report.hardGateFailures.some((f) => f.code === "UNSUPPORTED_DEFINITIVE_CLAIM"),
    ).toBe(true);
  });

  it("G: mixed supported/unsupported — supported survive, unsupported penalise", () => {
    const report = scoreResearchQuality({
      originalUserPrompt: "UK GDPR CRM contact storage",
      researchTopic: "UK GDPR CRM contact storage",
      claims: [
        {
          claim: "Lawful basis is required for processing personal data.",
          sourceUrl: ICO,
          evidenceExcerpt: "You must have a lawful basis to process personal data.",
          claimKind: "OFFICIAL",
          confidence: 0.8,
        },
        {
          claim: "Unsupported absolute claim with no URL.",
          claimKind: "OFFICIAL",
        },
      ],
      sources: AUTH_SOURCES,
      finalAnswerText: "Lawful basis is required; also an unsupported absolute claim.",
    });
    expect(report.claimConfidences.length).toBe(2);
    expect(report.accepted).toBe(false);
    expect(
      report.hardGateFailures.some((f) => f.code === "UNSUPPORTED_DEFINITIVE_CLAIM"),
    ).toBe(true);
    // Supported claim still contributes confidence entry with non-trivial conf.
    expect(report.claimConfidences.some((c) => c.confidence >= 70)).toBe(true);
  });

  it("H: strong authority sources but poor claim linkage → high source quality alone must NOT guarantee acceptance", () => {
    const report = scoreResearchQuality({
      originalUserPrompt:
        "Research the current UK GDPR requirements for storing customer contact details in a CRM.",
      researchTopic:
        "Research the current UK GDPR requirements for storing customer contact details in a CRM.",
      claims: [],
      sources: AUTH_SOURCES,
      finalAnswerText: "Sources were collected but no claims linked.",
    });
    expect(report.accepted).toBe(false);
    expect(report.overall).toBe(0);
    expect(report.breakdown.sourceQuality).toBeGreaterThan(50);
    expect(
      report.hardGateFailures.some((f) =>
        /no verifiable claims were linked/i.test(f.message),
      ),
    ).toBe(true);
  });

  it("I: strong authority + strong claim linkage → meaningful non-zero RQS", () => {
    const { report } = scoreFromDeepShaped({
      findings: fifteenGroundedFindings(),
    });
    expect(report.overall).toBeGreaterThan(40);
    expect(report.claimConfidences.length).toBe(15);
    expect(report.breakdown.factualAccuracy).toBeGreaterThan(50);
    expect(report.breakdown.sourceQuality).toBeGreaterThan(50);
  });
});

describe("RQS score variance (Round 7C)", () => {
  it("produces materially different scores across evidence strengths", () => {
    const strong = scoreFromDeepShaped({ findings: fifteenGroundedFindings() }).report;

    const weakGrounding = scoreResearchQuality({
      originalUserPrompt: "UK GDPR CRM storage",
      researchTopic: "UK GDPR CRM storage",
      claims: fifteenGroundedFindings().map((f) => ({
        claim: f.claim,
        sourceUrl: f.sourceUrl,
        // weak: no excerpt
        claimKind: "INFERENCE",
        confidence: 0.4,
      })),
      sources: AUTH_SOURCES,
      finalAnswerText: "Weakly grounded CRM GDPR notes.",
    });

    const weakEvidence = scoreResearchQuality({
      originalUserPrompt: "UK GDPR CRM storage",
      researchTopic: "UK GDPR CRM storage",
      claims: [
        {
          claim: "A blog says CRM storage is fine somehow.",
          sourceUrl: BLOG,
          evidenceExcerpt: "CRM storage is fine somehow according to this blog post.",
          claimKind: "SECONDARY",
          confidence: 0.4,
        },
      ],
      sources: [{ url: BLOG, title: "Random blog", platform: "web" }],
      finalAnswerText: "A blog says CRM storage is fine somehow.",
    });

    const unsupported = scoreResearchQuality({
      originalUserPrompt: "UK GDPR CRM storage",
      researchTopic: "UK GDPR CRM storage",
      claims: [{ claim: "Absolute unsupported definitive statement.", claimKind: "OFFICIAL" }],
      sources: AUTH_SOURCES,
      finalAnswerText: "Absolute unsupported definitive statement.",
    });

    const zero = scoreResearchQuality({
      originalUserPrompt: "UK GDPR CRM storage",
      researchTopic: "UK GDPR CRM storage",
      claims: [],
      sources: [],
      finalAnswerText: "",
    });

    const scores = {
      strong: strong.overall,
      weakGrounding: weakGrounding.overall,
      weakEvidence: weakEvidence.overall,
      unsupported: unsupported.overall,
      zero: zero.overall,
    };

    expect(scores.strong).toBeGreaterThan(scores.weakGrounding);
    expect(scores.strong).toBeGreaterThan(scores.weakEvidence);
    expect(scores.unsupported).toBeLessThan(scores.strong);
    expect(scores.zero).toBe(0);
    expect(unsupported.accepted).toBe(false);
    expect(zero.accepted).toBe(false);

    // Distinct set — not a fixed rubber stamp.
    const unique = new Set(Object.values(scores));
    expect(unique.size).toBeGreaterThanOrEqual(3);

    // Expose for report capture
    console.log("RQS_VARIANCE_RESULTS", JSON.stringify(scores));
  });
});
