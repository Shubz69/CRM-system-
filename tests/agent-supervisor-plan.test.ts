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

  it("QUICK mode skips vague clarification and uses CRM desk", () => {
    const result = planAgentRunDeterministic("What should I do today?", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.steps[0]?.agentName).toBe("crm_desk");
    expect((result.plan.steps[0]?.input as { intent?: string }).intent).toBe("operator_brief");
  });

  it("QUICK research uses a single FAST research step", () => {
    const result = planAgentRunDeterministic("Research UK SME AI adoption barriers", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0]?.agentName).toBe("research");
    expect((result.plan.steps[0]?.input as { depth?: string }).depth).toBe("FAST");
  });

  it("routes research about CRM topics to research, not Inbox/CRM desk", () => {
    const result = planAgentRunDeterministic(
      "Research competing views on CRM follow-up timing for B2B SMEs using external sources only. Cite sources. Do not use my Inbox or CRM records.",
      { organisationId: "org_test", answerMode: "DEEP" },
    );
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.steps.some((s) => s.agentName === "research")).toBe(true);
    expect(result.plan.steps.some((s) => s.agentName === "crm_desk")).toBe(false);
  });

  it("routes who needs a reply to CRM follow_ups", () => {
    const result = planAgentRunDeterministic("Who needs a reply in my CRM?");
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.steps[0]?.agentName).toBe("crm_desk");
  });

  it("routes company list and goals/KPI to CRM desk with correct intents", () => {
    const company = planAgentRunDeterministic("List my companies", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(company.kind).toBe("plan");
    if (company.kind === "plan") {
      expect(company.plan.steps[0]?.agentName).toBe("crm_desk");
    }

    const goals = planAgentRunDeterministic("Which goals are at risk in my CRM?", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(goals.kind).toBe("plan");
    if (goals.kind === "plan") {
      expect(goals.plan.steps[0]?.agentName).toBe("crm_desk");
      expect((goals.plan.steps[0]?.input as { intent?: string }).intent).toBe("goals_at_risk");
    }

    const kpiOperator = planAgentRunDeterministic("Which KPI needs attention?", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(kpiOperator.kind).toBe("plan");
    if (kpiOperator.kind === "plan") {
      expect((kpiOperator.plan.steps[0]?.input as { intent?: string }).intent).toBe(
        "operator_brief",
      );
    }

    const bp = planAgentRunDeterministic("What does our business sell?", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(bp.kind).toBe("plan");
    if (bp.kind === "plan") {
      expect((bp.plan.steps[0]?.input as { intent?: string }).intent).toBe("business_context");
    }

    const stalled = planAgentRunDeterministic("Which deals look stalled?", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(stalled.kind).toBe("plan");
    if (stalled.kind === "plan") {
      expect((stalled.plan.steps[0]?.input as { intent?: string }).intent).toBe("pipeline_summary");
    }
  });

  it("routes content waiting phrasing without clarification", () => {
    const result = planAgentRunDeterministic("Any content waiting for approval?", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(result.kind).toBe("plan");
    if (result.kind === "plan") {
      expect(result.plan.steps[0]?.agentName).toBe("crm_desk");
      expect((result.plan.steps[0]?.input as { intent?: string }).intent).toBe(
        "content_awaiting_approval",
      );
    }
  });

  it("routes who needs a reply to follow_ups not full operator brief", () => {
    const result = planAgentRunDeterministic("Who needs a reply in Inbox?", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(result.kind).toBe("plan");
    if (result.kind === "plan") {
      expect((result.plan.steps[0]?.input as { intent?: string }).intent).toBe("follow_ups");
    }
  });

  it("routes automate/deprioritise phrasing to operator_brief", () => {
    const auto = planAgentRunDeterministic("What should I automate from my CRM?", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(auto.kind).toBe("plan");
    if (auto.kind === "plan") {
      expect((auto.plan.steps[0]?.input as { intent?: string }).intent).toBe("operator_brief");
    }
  });

  it("does not clarify normal ambiguous business questions in QUICK", () => {
    for (const q of [
      "How is the pipeline looking?",
      "What's urgent?",
      "Any fires today?",
      "Give me a status check",
      "Do we have goals currently at risk?",
      "What opportunities should I review?",
    ]) {
      const result = planAgentRunDeterministic(q, {
        organisationId: "org_test",
        answerMode: "QUICK",
      });
      expect(result.kind).toBe("plan");
      if (result.kind === "plan") {
        expect(result.plan.steps[0]?.agentName).toBe("crm_desk");
      }
    }
  });

  it("ACTION mode prefers operator_brief for who-needs-reply judgement questions", () => {
    const result = planAgentRunDeterministic("Who needs a reply?", {
      organisationId: "org_test",
      answerMode: "ACTION",
    });
    expect(result.kind).toBe("plan");
    if (result.kind === "plan") {
      expect((result.plan.steps[0]?.input as { intent?: string }).intent).toBe("operator_brief");
    }
  });

  it("QUICK keeps pipeline looking on pipeline_summary", () => {
    const result = planAgentRunDeterministic("How is the pipeline looking?", {
      organisationId: "org_test",
      answerMode: "QUICK",
    });
    expect(result.kind).toBe("plan");
    if (result.kind === "plan") {
      expect((result.plan.steps[0]?.input as { intent?: string }).intent).toBe("pipeline_summary");
    }
  });
});
