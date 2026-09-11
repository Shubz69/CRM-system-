import { describe, expect, it } from "vitest";
import { planAgentRunDeterministic, looksLikeCrmInternal } from "@/agents/supervisor/plan";

describe("phase8d differentiation routing", () => {
  const qs = [
    "What should our next revenue priority be this week, based on our CRM and pipeline?",
    "Who is our ideal customer and how should we reach them?",
    "Summarise open risks in our sales pipeline and one concrete next action.",
    "What automation would help without sending anything externally yet?",
    "What content idea would best serve our wellness studio audience this week?",
  ] as const;
  for (const q of qs) {
    it(`ACTION routes judgement: ${q.slice(0, 40)}`, () => {
      const p = planAgentRunDeterministic(q, { organisationId: "org", answerMode: "ACTION" });
      expect(p.kind).toBe("plan");
      if (p.kind !== "plan") return;
      const intent = (p.plan.steps[0]?.input as { intent?: string })?.intent;
      console.log(q.slice(0, 50), "->", intent);
      if (/ideal customer/i.test(q)) {
        expect(intent).toBe("business_context");
      } else {
        expect(["operator_brief", "business_context"]).toContain(intent);
      }
    });
  }
});
