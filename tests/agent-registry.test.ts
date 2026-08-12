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

describe("agent registry", () => {
  beforeEach(() => {
    resetAgentBootstrap();
  });

  it("registers Echo and Summarise exactly once via ensureAgentsRegistered", () => {
    ensureAgentsRegistered();
    const names = listAgents()
      .map((a) => a.name)
      .sort();
    expect(names).toEqual(["echo", "summarise"]);
    expect(getAgent("echo").name).toBe("echo");
    expect(getAgent("summarise").name).toBe("summarise");
    ensureAgentsRegistered();
    expect(listAgents()).toHaveLength(2);
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
    };

    for (const agent of listAgents()) {
      const input = samples[agent.name];
      expect(input).toBeTruthy();
      const label = agent.userFacingLabel(input as never);
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toMatch(/Agent\.|execute|Zod|tier|balanced|cheap|heavy/i);
      expect(label).not.toMatch(/echoAgent|summariseAgent/i);
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
      userFacingLabel: () => "   ",
      async execute() {
        return { output: { ok: true }, costCents: 0 };
      },
    };
    registerAgent(bad);
    expect(bad.userFacingLabel({ text: "x" }).trim()).toBe("");
  });
});
