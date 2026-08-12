import { beforeEach, describe, expect, it, vi } from "vitest";

const agentRunFindFirst = vi.fn();
const agentRunUpdateMany = vi.fn(async () => ({ count: 1 }));
const agentStepCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: `step_${String(args.data.position)}`,
  ...args.data,
}));
const agentStepUpdateMany = vi.fn(async () => ({ count: 1 }));
const organisationFindFirst = vi.fn(async () => ({ id: "org_a", name: "Demo" }));
const limitsFindUnique = vi.fn(async () => null);

vi.mock("@/lib/db", () => ({
  prisma: {
    agentRun: {
      findFirst: (...a: unknown[]) => agentRunFindFirst(...a),
      updateMany: (...a: unknown[]) => agentRunUpdateMany(...a),
    },
    agentStep: {
      create: (...a: unknown[]) => agentStepCreate(...a),
      updateMany: (...a: unknown[]) => agentStepUpdateMany(...a),
    },
    organisation: {
      findFirst: (...a: unknown[]) => organisationFindFirst(...a),
    },
    organisationAgentLimits: {
      findUnique: (...a: unknown[]) => limitsFindUnique(...a),
    },
  },
}));

vi.mock("@/services/ai-spend-gate", () => {
  class SpendCapExceededError extends Error {
    code = "SPEND_CAP_EXCEEDED";
    constructor(
      message: string,
      public organisationId: string,
      public spentCents: number,
      public capCents: number,
    ) {
      super(message);
      this.name = "SpendCapExceededError";
    }
  }
  return {
    assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
    SpendCapExceededError,
  };
});

import { executeAgentRun } from "@/agents/supervisor/execute";
import { assertWithinSpendCap, SpendCapExceededError } from "@/services/ai-spend-gate";
import { registerAgent, resetAgentBootstrap } from "@/agents";
import { echoAgent } from "@/agents/echo";
import { summariseAgent } from "@/agents/summarise";

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    organisationId: "org_a",
    userId: "user_1",
    triggeredBy: "user",
    request: 'Echo: "hello clinic"',
    plan: null,
    plainEnglishPlan: null,
    clarificationQuestion: null,
    clarificationOptions: null,
    status: "PENDING",
    startedAt: null,
    finishedAt: null,
    totalCostCents: 0,
    error: null,
    userFacingError: null,
    partialResults: null,
    finalOutput: null,
    maxSteps: 8,
    maxWallClockSeconds: 600,
    maxSpendCents: null,
    bullJobId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("supervisor execution — budget, partial results, clarification", () => {
  beforeEach(() => {
    resetAgentBootstrap();
    registerAgent(echoAgent);
    registerAgent(summariseAgent);
    agentRunFindFirst.mockReset();
    agentRunUpdateMany.mockClear();
    agentStepCreate.mockClear();
    agentStepUpdateMany.mockClear();
    vi.mocked(assertWithinSpendCap).mockReset();
    vi.mocked(assertWithinSpendCap).mockResolvedValue({
      ok: true,
      spentCents: 0,
      capCents: null,
    });
  });

  it("returns clarification without executing steps when request is ambiguous", async () => {
    agentRunFindFirst.mockResolvedValue(baseRun({ request: "help me" }));
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_1" });
    expect(result.status).toBe("AWAITING_CLARIFICATION");
    expect(agentStepCreate).not.toHaveBeenCalled();
    expect(agentRunUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run_1", organisationId: "org_a" },
        data: expect.objectContaining({ status: "AWAITING_CLARIFICATION" }),
      }),
    );
  });

  it("writes AgentStep rows as execution progresses and completes echo", async () => {
    agentRunFindFirst.mockResolvedValue(baseRun());
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_1" });
    expect(result.status).toBe("COMPLETED");
    expect(agentStepCreate).toHaveBeenCalled();
    const createData = agentStepCreate.mock.calls[0]![0].data;
    expect(createData.organisationId).toBe("org_a");
    expect(createData.userFacingLabel).toMatch(/Repeating/i);
    expect(createData.status).toBe("RUNNING");
    expect(agentStepUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organisationId: "org_a" }),
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });

  it("enforces max steps and returns PARTIAL with plain-English note", async () => {
    agentRunFindFirst.mockResolvedValue(
      baseRun({
        request: "Summarise then echo this longish note about our clinic services",
        maxSteps: 1,
        plan: {
          steps: [
            { agentName: "echo", input: { text: "one" } },
            { agentName: "echo", input: { text: "two" } },
          ],
          plainEnglishPlan: "Two quick checks.",
        },
      }),
    );
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_1" });
    expect(result.status).toBe("PARTIAL");
    expect(result.userFacingError).toMatch(/maximum|steps/i);
    expect(agentStepCreate).toHaveBeenCalledTimes(1);
  });

  it("returns PARTIAL when monthly spend gate blocks a later step", async () => {
    agentRunFindFirst.mockResolvedValue(
      baseRun({
        plan: {
          steps: [
            { agentName: "echo", input: { text: "first" } },
            { agentName: "echo", input: { text: "second" } },
          ],
          plainEnglishPlan: "Two repeats.",
        },
      }),
    );

    vi.mocked(assertWithinSpendCap)
      .mockResolvedValueOnce({ ok: true, spentCents: 0, capCents: 100 })
      .mockRejectedValueOnce(new SpendCapExceededError("cap", "org_a", 100, 100));

    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_1" });
    expect(result.status).toBe("PARTIAL");
    expect(result.userFacingError).toMatch(/allowance/i);
    expect(agentStepCreate).toHaveBeenCalledTimes(1);
  });

  it("returns PARTIAL (not bare error) when a step throws after prior success", async () => {
    const failing = {
      ...echoAgent,
      name: "echo-fail",
      async execute() {
        throw new Error("boom");
      },
    };
    registerAgent(failing as typeof echoAgent);

    agentRunFindFirst.mockResolvedValue(
      baseRun({
        plan: {
          steps: [
            { agentName: "echo", input: { text: "ok" } },
            { agentName: "echo-fail", input: { text: "nope" } },
          ],
          plainEnglishPlan: "Try both.",
        },
      }),
    );

    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_1" });
    expect(result.status).toBe("PARTIAL");
    expect(result.userFacingError).toMatch(/completed 1/i);
    expect(result.partialResults).toBeTruthy();
  });

  it("checks spend gate before every step", async () => {
    agentRunFindFirst.mockResolvedValue(
      baseRun({
        plan: {
          steps: [
            { agentName: "echo", input: { text: "a" } },
            { agentName: "echo", input: { text: "b" } },
          ],
          plainEnglishPlan: "Two.",
        },
      }),
    );
    await executeAgentRun({ organisationId: "org_a", runId: "run_1" });
    expect(assertWithinSpendCap).toHaveBeenCalledTimes(2);
    expect(assertWithinSpendCap).toHaveBeenCalledWith("org_a", expect.any(Number));
  });
});
