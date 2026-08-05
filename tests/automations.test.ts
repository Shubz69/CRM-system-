import { describe, expect, it } from "vitest";
import { matchesConditions } from "@/services/automations";

describe("matchesConditions", () => {
  const context = { organisationId: "org", triggerType: "lead_created", payload: { score: 80, sentiment: "positive", inactiveMinutes: 90 } };

  it("matches satisfied conditions", () => {
    expect(matchesConditions({ minScore: 70, sentiment: "positive", minutes: 60 }, context)).toBe(true);
  });

  it("rejects unmet conditions", () => {
    expect(matchesConditions({ minScore: 90 }, context)).toBe(false);
    expect(matchesConditions({ sentiment: "negative" }, context)).toBe(false);
  });
});
