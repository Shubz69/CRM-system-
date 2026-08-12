import { describe, expect, it } from "vitest";
import { planAgentRunDeterministic } from "@/agents/supervisor/plan";

describe("supervisor planning", () => {
  it("plans an echo request with plainEnglishPlan", () => {
    const result = planAgentRunDeterministic('Echo: "Welcome to Bright Smile Dental"');
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0]?.agentName).toBe("echo");
    expect(result.plan.plainEnglishPlan.length).toBeGreaterThan(10);
    expect(result.plan.plainEnglishPlan).not.toMatch(/Agent|execute|Supervisor/i);
  });

  it("plans a summarise request", () => {
    const result = planAgentRunDeterministic(
      "Summarise this: We help local clinics book more consults through Instagram DMs every week.",
    );
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.steps[0]?.agentName).toBe("summarise");
    expect(result.plan.plainEnglishPlan).toMatch(/summar/i);
  });

  it("asks exactly one clarifying question when the request is ambiguous", () => {
    const result = planAgentRunDeterministic("help me");
    expect(result.kind).toBe("clarification");
    if (result.kind !== "clarification") return;
    expect(result.question.length).toBeGreaterThan(5);
    expect(result.options.length).toBeGreaterThanOrEqual(2);
    expect(result.options.length).toBeLessThanOrEqual(4);
  });

  it("defaults long body without a verb to summarise", () => {
    const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(" ");
    const result = planAgentRunDeterministic(long);
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.steps[0]?.agentName).toBe("summarise");
  });
});
