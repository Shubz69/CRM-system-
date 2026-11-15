/**
 * The research quality gate (claims/sources scoring → "Quality gate failed…" gaps)
 * applies to web-research answers only — never to answers built from the
 * workspace's own data (crm_desk, content drafts) or image results.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentRunFindFirst = vi.fn();
const agentRunUpdateMany = vi.fn(async () => ({ count: 1 }));
const agentStepCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: `step_${String(args.data.position)}`,
  ...args.data,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    agentRun: {
      findFirst: (...a: unknown[]) => agentRunFindFirst(...a),
      updateMany: (...a: unknown[]) => agentRunUpdateMany(...a),
      update: vi.fn(async () => ({})),
    },
    agentStep: {
      create: (...a: unknown[]) => agentStepCreate(...a),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({ id: "step_0" })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
    },
    organisation: { findFirst: vi.fn(async () => ({ id: "org_a", name: "Glow Salon" })) },
    organisationAgentLimits: { findUnique: vi.fn(async () => null) },
    researchJob: { findFirst: vi.fn(async () => null) },
  },
}));

vi.mock("@/services/ai-spend-gate", () => ({
  assertWithinSpendCap: vi.fn(async () => ({ ok: true, spentCents: 0, capCents: null })),
  SpendCapExceededError: class extends Error {},
}));

import { z } from "zod";
import { executeAgentRun } from "@/agents/supervisor/execute";
import { registerAgent, resetAgentBootstrap } from "@/agents";
import { crmDeskInputSchema } from "@/agents/crm-desk";
import type { AnyAgent } from "@/agents/types";

function baseRun(overrides: Record<string, unknown>) {
  return {
    id: "run_1",
    organisationId: "org_a",
    userId: "user_1",
    triggeredBy: "user",
    request: "Common objections this week",
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
    referenceAssetId: null,
    answerMode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const fakeCrmDesk: AnyAgent = {
  name: "crm_desk",
  description: "fake crm desk",
  inputSchema: crmDeskInputSchema,
  outputSchema: z.unknown(),
  tier: "cheap",
  estimateCostCents: () => 0,
  userFacingLabel: () => "Grouping objections from recent conversations",
  async execute() {
    return {
      output: {
        source: "internal_crm",
        organisationId: "org_a",
        shortAnswer: "2 objections in the last 7 days — most common: Price (2).",
        summary: "OBJECTIONS — last 7 days: 2 across 1 category\n1. Price — 2 (100%)",
        counts: {
          openDeals: 0,
          stalledDeals: 0,
          conversationsNeedingHuman: 0,
          conversationsNeedingReply: 0,
          goalsAtRisk: 0,
          contentAwaitingApproval: 0,
        },
        deals: [],
        conversations: [],
        goals: [],
        content: [],
      },
      costCents: 0,
    };
  },
};

const fakeResearch: AnyAgent = {
  name: "research",
  description: "fake research",
  inputSchema: z.object({ topic: z.string() }).passthrough(),
  outputSchema: z.unknown(),
  tier: "cheap",
  estimateCostCents: () => 0,
  userFacingLabel: () => "Researching sources",
  async execute() {
    return {
      output: {
        researchJobId: "job_1",
        topic: "bridal hair trends",
        queries: [],
        sourceCount: 0,
        findings: [],
        sources: [],
        summary: "No sources returned.",
        adapterErrors: [],
      },
      costCents: 0,
    };
  },
};

function hasQualityGate(output: unknown): boolean {
  const json = JSON.stringify(output ?? null);
  return /Quality gate failed|researchQuality/.test(json);
}

describe("research quality gate scope", () => {
  beforeEach(() => {
    resetAgentBootstrap();
    registerAgent(fakeCrmDesk);
    registerAgent(fakeResearch);
    agentRunFindFirst.mockReset();
    agentStepCreate.mockClear();
  });

  it.each([null, "EXECUTIVE", "DEEP"])(
    "CRM workspace answers are never quality-gated (answerMode %s)",
    async (answerMode) => {
      agentRunFindFirst.mockResolvedValue(baseRun({ answerMode }));
      const result = await executeAgentRun({ organisationId: "org_a", runId: "run_1" });
      expect(result.status).toBe("COMPLETED");
      expect(agentStepCreate.mock.calls[0]![0].data.agentName).toBe("crm_desk");
      expect(hasQualityGate(result.finalOutput)).toBe(false);
      expect(JSON.stringify(result.finalOutput)).toMatch(/Price/);
    },
  );

  it("web research answers still get the quality gate", async () => {
    agentRunFindFirst.mockResolvedValue(
      baseRun({
        request: "Research bridal hair trends in Leeds with sources",
        answerMode: "EXECUTIVE",
        plan: {
          steps: [{ agentName: "research", input: { topic: "bridal hair trends in Leeds" } }],
          plainEnglishPlan: "Research.",
        },
      }),
    );
    const result = await executeAgentRun({ organisationId: "org_a", runId: "run_1" });
    expect(hasQualityGate(result.finalOutput)).toBe(true);
  });
});
