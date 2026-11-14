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

  it("fails closed when the event cannot answer a condition", () => {
    const bare = { organisationId: "org", triggerType: "lead_qualified" };
    expect(matchesConditions({ minScore: 70 }, bare)).toBe(false);
    expect(matchesConditions({ sentiment: "positive" }, bare)).toBe(false);
    expect(matchesConditions({ minutes: 30 }, bare)).toBe(false);
    expect(matchesConditions({}, bare)).toBe(true);
  });

  it("checks topic conditions against the message text", () => {
    const pricing = {
      organisationId: "org",
      triggerType: "new_inbound_message",
      payload: { text: "Hi, what's the PRICE for a full set?" },
    };
    const other = { ...pricing, payload: { text: "Are you open on Sunday?" } };
    expect(matchesConditions({ topicIncludes: ["pricing", "price"] }, pricing)).toBe(true);
    expect(matchesConditions({ topicIncludes: ["pricing", "price"] }, other)).toBe(false);
    expect(matchesConditions({ topicIncludes: "price" }, { ...pricing, payload: {} })).toBe(false);
  });

  it("treats requireHumanReview as an approval flag, not a filter", () => {
    expect(matchesConditions({ requireHumanReview: true }, context)).toBe(true);
  });
});
