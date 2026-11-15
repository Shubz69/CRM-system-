/**
 * Setup Assistant approve: never switches the workspace AI provider/model, and proposed
 * pipeline stages are reported as not applied (with where to add them) instead of being
 * silently ignored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  agentFindFirst: vi.fn(),
  agentUpdate: vi.fn(),
  stageFindMany: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requirePermission: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ ANTHROPIC_API_KEY: "k", AI_PROVIDER: "anthropic" }) }));
vi.mock("@/adapters/ai", () => ({ getAiProvider: () => ({ name: "anthropic" }) }));
vi.mock("@/adapters/ai/structured", () => ({ completeStructuredSafe: vi.fn() }));
vi.mock("@/lib/ai-models", () => ({ resolveModelForTier: () => "test-model" }));
vi.mock("@/services/ai-execution", () => ({ recordAiExecution: vi.fn() }));
vi.mock("@/services/audit", () => ({
  writeAuditLog: (...args: unknown[]) => mocks.writeAuditLog(...args),
}));
vi.mock("@/services/knowledge", () => ({ upsertKnowledgeDocument: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    knowledgeDocument: { findMany: vi.fn(async () => []) },
    agentConfiguration: {
      findFirst: (...args: unknown[]) => mocks.agentFindFirst(...args),
      update: (...args: unknown[]) => mocks.agentUpdate(...args),
    },
    qualificationField: { upsert: vi.fn() },
    pipelineStage: { findMany: (...args: unknown[]) => mocks.stageFindMany(...args) },
  },
}));

import { POST } from "@/app/api/setup-assistant/route";

function approve(proposal: unknown) {
  return POST(
    new NextRequest("http://localhost/api/setup-assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", proposal }),
    }),
  );
}

describe("Setup Assistant approve scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentFindFirst.mockResolvedValue({
      id: "cfg_a",
      aiProvider: "openai",
      model: "gpt-workspace",
      brandTone: "old",
      qualificationQuestions: [],
      scoringRules: {},
      handoverRules: {},
      followUpDelaysMinutes: [60],
      bookingConditions: {},
      disqualificationRules: [],
    });
    mocks.stageFindMany.mockResolvedValue([
      { name: "New", slug: "new" },
      { name: "Qualified", slug: "qualified" },
      { name: "Booked", slug: "booked" },
    ]);
  });

  it("does not change the AI provider or model", async () => {
    const res = await approve({ tone: "friendly" });
    expect(res.status).toBe(200);
    const data = mocks.agentUpdate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("aiProvider");
    expect(data).not.toHaveProperty("model");
    expect(data.brandTone).toBe("friendly");
  });

  it("reports proposed stages the pipeline lacks as not applied, with where to add them", async () => {
    const res = await approve({
      tone: "friendly",
      pipelineStages: [
        { name: "New", slug: "new" },
        { name: "Consultation booked", slug: "consultation_booked" },
        { name: "qualified", slug: "qualified_lead" },
        { name: "Deposit paid", slug: "deposit_paid" },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.notApplied.pipelineStages).toEqual(["Consultation booked", "Deposit paid"]);
    expect(json.message).toMatch(/not applied — add them in Pipeline → Edit stages/);
    expect(json.message).toContain("Consultation booked, Deposit paid");
    expect(mocks.stageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pipeline: { organisationId: "org_a", isDefault: true } } }),
    );
  });

  it("says nothing about stages when none were proposed or all exist", async () => {
    const json = await (await approve({ tone: "x", pipelineStages: [{ name: "Booked", slug: "booked" }] })).json();
    expect(json.notApplied.pipelineStages).toEqual([]);
    expect(json.message).toBe("Setup approved and saved.");
  });
});
