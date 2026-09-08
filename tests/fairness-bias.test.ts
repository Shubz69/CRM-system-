import { describe, expect, it } from "vitest";
import {
  businessPriorityScore,
  detectUnjustifiedAgreement,
  prioritiesAreEquivalent,
  stripIdentityCues,
} from "@/services/fairness-bias";

describe("fairness-bias", () => {
  it("scores identical business signals the same regardless of identity text", () => {
    const base = {
      dealValueCents: 25_000_00,
      intentScore: 80,
      stageAgeDays: 3,
      needsReply: false,
      evidenceStrength: 0.9,
    };
    expect(businessPriorityScore(base)).toBe(
      businessPriorityScore({ ...base }),
    );
    expect(
      prioritiesAreEquivalent(
        base,
        { ...base },
      ),
    ).toBe(true);
  });

  it("does not let name-like strings enter the business score", () => {
    const a = businessPriorityScore({
      dealValueCents: 10_000_00,
      intentScore: 50,
      needsReply: true,
    });
    const b = businessPriorityScore({
      dealValueCents: 10_000_00,
      intentScore: 50,
      needsReply: true,
    });
    expect(a).toBe(b);
    expect(stripIdentityCues("Ms Aisha Khan needs a reply")).toContain("needs a reply");
  });

  it("flags sycophancy when evidence does not support the user claim", () => {
    expect(
      detectUnjustifiedAgreement({
        userClaim: "Deal A is obviously the most important",
        answer: "I agree — Deal A is obviously the most important.",
        evidenceSupportsClaim: false,
      }),
    ).toBe(true);
    expect(
      detectUnjustifiedAgreement({
        userClaim: "Deal A is obviously the most important",
        answer:
          "Evidence is insufficient to treat Deal A as the top priority. Inbox replies are more urgent.",
        evidenceSupportsClaim: false,
      }),
    ).toBe(false);
  });
});
