import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureAgentsRegistered,
  getAgent,
  listAgents,
  registerAgent,
  resetAgentBootstrap,
} from "@/agents";
import { echoAgent } from "@/agents/echo";
import { summariseAgent } from "@/agents/summarise";
import { z } from "zod";
import type { Agent } from "@/agents/types";
import { planAgentRunDeterministic } from "@/agents/supervisor/plan";

describe("agent registry", () => {
  beforeEach(() => {
    resetAgentBootstrap();
  });

  it("registers built-in agents including research pipeline", () => {
    ensureAgentsRegistered();
    const names = listAgents()
      .map((a) => a.name)
      .sort();
    expect(names).toEqual([
      "analyst",
      "critic",
      "crm_desk",
      "echo",
      "imaging_analyze",
      "imaging_generate",
      "research",
      "social_listening",
      "summarise",
    ]);
    expect(getAgent("research").name).toBe("research");
    ensureAgentsRegistered();
    expect(listAgents()).toHaveLength(9);
  });

  it("rejects duplicate registration", () => {
    registerAgent(echoAgent);
    expect(() => registerAgent(echoAgent)).toThrow(/already registered/);
  });

  it("every registered agent produces a non-empty userFacingLabel", () => {
    ensureAgentsRegistered();

    const samples: Record<string, unknown> = {
      echo: { text: "Hello from the clinic" },
      summarise: {
        text: "We offer implants and whitening for busy professionals.",
        maxSentences: 2,
      },
      research: { topic: "plant hire equipment for construction sites" },
      social_listening: { topic: "dental practice software reviews" },
      analyst: { researchJobId: "job_1", topic: "product model X200" },
      critic: { researchJobId: "job_1" },
      imaging_analyze: {
        request: "Make something warmer like this",
        referenceAssetId: "asset_1",
      },
      imaging_generate: {
        prompt: "A calm workspace with soft morning light",
        referenceAssetId: "asset_1",
      },
      crm_desk: { intent: "pipeline_summary", request: "Summarise my pipeline" },
    };

    for (const agent of listAgents()) {
      const input = samples[agent.name];
      expect(input).toBeTruthy();
      const label = agent.userFacingLabel(input as never);
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toMatch(/Agent\.|execute|Zod|tier|balanced|cheap|heavy/i);
    }
  });

  it("Echo execute returns the same text", async () => {
    ensureAgentsRegistered();
    const result = await echoAgent.execute(
      { text: "ping" },
      { organisationId: "org", agentRunId: "run", agentStepId: "step" },
    );
    expect(result.output.echo).toBe("ping");
    expect(result.costCents).toBe(0);
  });

  it("plans research → analyst → critic for research requests", () => {
    const plan = planAgentRunDeterministic("Research plant hire equipment pricing in the UK", {
      organisationId: "org_1",
      answerMode: "DEEP",
    });
    expect(plan.kind).toBe("plan");
    if (plan.kind !== "plan") return;
    expect(plan.plan.steps.map((s) => s.agentName)).toEqual([
      "research",
      "analyst",
      "critic",
    ]);
    expect(plan.plan.plainEnglishPlan).toMatch(/research/i);
  });

  it("plans social listening pipeline without assuming Instagram", () => {
    const plan = planAgentRunDeterministic(
      "Social listening on what hooks and formats work for dental practice software",
      { organisationId: "org_1", answerMode: "EXECUTIVE" },
    );
    expect(plan.kind).toBe("plan");
    if (plan.kind !== "plan") return;
    expect(plan.plan.steps[0]?.agentName).toBe("social_listening");
    expect(plan.plan.plainEnglishPlan.toLowerCase()).not.toMatch(/instagram/);
  });
});

describe("userFacingLabel contract", () => {
  beforeEach(() => {
    resetAgentBootstrap();
  });

  it("allows registering an agent whose label is empty (executor treats that as a bug)", () => {
    const bad: Agent<{ text: string }, { ok: boolean }> = {
      name: "bad-label",
      description: "test",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      tier: "cheap",
      estimateCostCents: () => 0,
      userFacingLabel: () => "",
      execute: async () => ({ output: { ok: true }, costCents: 0 }),
    };
    // Registry currently requires a function but does not validate emptiness at register time.
    expect(() => registerAgent(bad)).not.toThrow();
  });
});

// silence unused import if summarise only used historically
void summariseAgent;
