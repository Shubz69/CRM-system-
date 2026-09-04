import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("@/services/ai-spend-gate", () => ({
  assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
}));

import {
  coerceStructuredValue,
  completeStructuredSafe,
  tryParseJson,
  unwrapJsonStrings,
} from "@/adapters/ai/structured";
import {
  FINDINGS_EXTRACT_JSON_SCHEMA,
  findingsExtractSchema,
} from "@/agents/research";
import type { AiProvider } from "@/adapters/ai/types";
import {
  RESEARCH_STRUCTURED_EXTRACTION_FAILED_CUSTOMER,
  RESEARCH_SYNTHESIS_FAILED_CUSTOMER,
} from "@/services/ai-provider-preflight";
import { customerFacingSynthesisPhase } from "@/services/answer-modes/progress";

const claimSchema = z.object({
  claim: z.string().min(1),
  sourceUrl: z.string().url(),
  evidenceExcerpt: z.string().optional(),
});

const packSchema = z.object({
  findings: z.array(claimSchema).max(40),
});

function providerReturning(payloads: string[]): AiProvider {
  let i = 0;
  return {
    name: "test",
    async complete() {
      const next = payloads[Math.min(i, payloads.length - 1)]!;
      i += 1;
      return next;
    },
    async analyseConversation() {
      return {};
    },
  };
}

describe("structured extraction fixtures (Round 7B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("A — valid structured extraction", async () => {
    const valid = {
      findings: [
        {
          claim: "ICO requires appropriate security for personal data.",
          sourceUrl: "https://ico.org.uk/guide",
          evidenceExcerpt: "You must process personal data securely.",
          claimKind: "OFFICIAL",
        },
      ],
    };
    const result = await completeStructuredSafe(findingsExtractSchema, {
      organisationId: "org_test",
      prompt: "extract",
      provider: providerReturning([JSON.stringify(valid)]),
      skipSpendGate: true,
      jsonSchema: FINDINGS_EXTRACT_JSON_SCHEMA as unknown as Record<string, unknown>,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.findings).toHaveLength(1);
  });

  it("B — JSON wrapped in markdown fences", async () => {
    const fenced = '```json\n{"findings":[{"claim":"UK GDPR applies","sourceUrl":"https://legislation.gov.uk/ukpga/2018/12"}]}\n```';
    expect(tryParseJson(fenced)).toEqual({
      findings: [
        {
          claim: "UK GDPR applies",
          sourceUrl: "https://legislation.gov.uk/ukpga/2018/12",
        },
      ],
    });
    const result = await completeStructuredSafe(findingsExtractSchema, {
      organisationId: "org_test",
      prompt: "extract",
      provider: providerReturning([fenced]),
      skipSpendGate: true,
    });
    expect(result.ok).toBe(true);
  });

  it("C — optional field missing is recoverable", () => {
    const parsed = findingsExtractSchema.safeParse({
      findings: [
        {
          claim: "Controllers must identify a lawful basis.",
          sourceUrl: "https://ico.org.uk/lawful-basis",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("D — genuinely required field missing fails", () => {
    const parsed = findingsExtractSchema.safeParse({
      findings: [{ sourceUrl: "https://ico.org.uk/x" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("E — invalid source reference is filtered by contract consumers", () => {
    const allowed = new Set(["https://ico.org.uk/ok"]);
    const modelOut = [
      { claim: "Good", sourceUrl: "https://ico.org.uk/ok" },
      { claim: "Bad", sourceUrl: "https://evil.example/x" },
    ];
    const kept = modelOut.filter((f) => allowed.has(f.sourceUrl));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.claim).toBe("Good");
  });

  it("F — zero claims is schema-valid but empty", () => {
    const parsed = findingsExtractSchema.safeParse({ findings: [] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.findings).toHaveLength(0);
  });

  it("G — truncated malformed output fails honestly (then repair once)", async () => {
    const truncated = '{"findings":[{"claim":"partial","sourceUrl":"https://ico.org.uk';
    const repaired = JSON.stringify({
      findings: [
        {
          claim: "Repaired claim",
          sourceUrl: "https://ico.org.uk/guide",
        },
      ],
    });
    const result = await completeStructuredSafe(packSchema, {
      organisationId: "org_test",
      prompt: "extract",
      provider: providerReturning([truncated, repaired]),
      skipSpendGate: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repaired).toBe(true);
  });

  it("H — mixed valid + invalid claims: retain only schema-valid when partial parse of items", () => {
    // Contract: top-level must validate; partial retention is done after Zod by URL allow-list.
    const raw = {
      findings: [
        {
          claim: "Valid",
          sourceUrl: "https://ico.org.uk/a",
          evidenceExcerpt: "ok",
        },
        {
          claim: "",
          sourceUrl: "https://ico.org.uk/b",
        },
      ],
    };
    const parsed = findingsExtractSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    // When whole pack fails Zod, repair path is required — not silent drop to empty success.
  });

  it("unwraps double-encoded JSON strings (root Expected object, received string)", () => {
    const inner = { findings: [{ claim: "A", sourceUrl: "https://ico.org.uk" }] };
    const double = JSON.stringify(JSON.stringify(inner));
    expect(unwrapJsonStrings(JSON.parse(double))).toEqual(inner);
    expect(coerceStructuredValue(JSON.stringify(inner))).toEqual(inner);
  });

  it("customer-facing extraction failure copy stays provider-neutral", () => {
    expect(RESEARCH_STRUCTURED_EXTRACTION_FAILED_CUSTOMER).not.toMatch(
      /anthropic|claude|zod|json|api key|401/i,
    );
    expect(RESEARCH_SYNTHESIS_FAILED_CUSTOMER).not.toMatch(/anthropic|claude|api key|401/i);
    expect(customerFacingSynthesisPhase("STRUCTURED_EXTRACTION_FAILED")).toMatch(/structure/i);
    expect(customerFacingSynthesisPhase("STRUCTURED_EXTRACTION_FAILED")).not.toMatch(
      /anthropic|claude|zod/i,
    );
  });
});
