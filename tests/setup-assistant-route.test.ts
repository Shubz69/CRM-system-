/**
 * Setup Assistant: proposals use a structured completion with the proposal's own schema (not the
 * inbound decision schema), and approved knowledge goes through the knowledge service (chunked,
 * upserted) instead of raw knowledgeDocument.create.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  completeStructuredSafe: vi.fn(),
  analyseConversation: vi.fn(),
  upsertKnowledgeDocument: vi.fn(),
  knowledgeCreate: vi.fn(),
  knowledgeFindMany: vi.fn(),
  agentFindFirst: vi.fn(),
  agentUpdate: vi.fn(),
  qualificationUpsert: vi.fn(),
  recordAiExecution: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requirePermission: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ ANTHROPIC_API_KEY: "test-key", AI_PROVIDER: "anthropic" }),
}));

vi.mock("@/adapters/ai", () => ({
  getAiProvider: () => ({
    name: "anthropic",
    complete: vi.fn(),
    analyseConversation: (...args: unknown[]) => mocks.analyseConversation(...args),
  }),
}));

vi.mock("@/adapters/ai/structured", () => ({
  completeStructuredSafe: (...args: unknown[]) => mocks.completeStructuredSafe(...args),
}));

vi.mock("@/lib/ai-models", () => ({
  resolveModelForTier: () => "test-model",
}));

vi.mock("@/services/ai-execution", () => ({
  recordAiExecution: (...args: unknown[]) => mocks.recordAiExecution(...args),
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: (...args: unknown[]) => mocks.writeAuditLog(...args),
}));

vi.mock("@/services/knowledge", () => ({
  upsertKnowledgeDocument: (...args: unknown[]) => mocks.upsertKnowledgeDocument(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    knowledgeDocument: {
      create: (...args: unknown[]) => mocks.knowledgeCreate(...args),
      findMany: (...args: unknown[]) => mocks.knowledgeFindMany(...args),
    },
    agentConfiguration: {
      findFirst: (...args: unknown[]) => mocks.agentFindFirst(...args),
      update: (...args: unknown[]) => mocks.agentUpdate(...args),
    },
    qualificationField: { upsert: (...args: unknown[]) => mocks.qualificationUpsert(...args) },
  },
}));

import { POST } from "@/app/api/setup-assistant/route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/setup-assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const proposal = {
  reply: "Configured for a UK automation agency.",
  tone: "friendly, direct",
  qualificationQuestions: ["Do you run a business?", "Who makes the decision?"],
  knowledgeStructure: [
    { title: "What we sell", category: "business", content: "AI automation systems for UK SMEs." },
    { title: "Empty doc", category: "faq", content: "   " },
  ],
  qualificationFields: [{ key: "business_type", label: "Business type" }],
};

describe("Setup Assistant propose", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses a structured completion with the setup proposal schema, not analyseConversation", async () => {
    mocks.completeStructuredSafe.mockResolvedValue({ ok: true, data: proposal, repaired: false, raw: proposal });
    const res = await post({
      action: "propose",
      businessDescription: "We sell AI automation systems to UK SMEs with decision makers.",
    });
    expect(res.status).toBe(200);
    expect(mocks.analyseConversation).not.toHaveBeenCalled();
    const [schema, options] = mocks.completeStructuredSafe.mock.calls[0]! as [
      { safeParse: (v: unknown) => { success: boolean } },
      { organisationId: string; system: string; prompt: string },
    ];
    expect(options.organisationId).toBe("org_a");
    expect(options.system).toMatch(/Setup Assistant/);
    expect(options.system).not.toMatch(/structured decision schema/i);
    expect(options.prompt).toMatch(/UK SMEs/);
    expect(schema.safeParse(proposal).success).toBe(true);
    expect((await res.json()).proposal).toEqual(proposal);
  });

  it("returns 502 when the model produced nothing configurable", async () => {
    mocks.completeStructuredSafe.mockResolvedValue({ ok: true, data: { reply: "hi" }, repaired: false, raw: {} });
    const res = await post({
      action: "propose",
      businessDescription: "We sell AI automation systems to UK SMEs with decision makers.",
    });
    expect(res.status).toBe(502);
  });
});

describe("Setup Assistant approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertKnowledgeDocument.mockResolvedValue("doc_1");
    mocks.knowledgeFindMany.mockResolvedValue([]);
    mocks.agentFindFirst.mockResolvedValue({
      id: "cfg_a",
      brandTone: "old",
      qualificationQuestions: [],
      scoringRules: {},
      handoverRules: {},
      followUpDelaysMinutes: [60],
      bookingConditions: {},
      disqualificationRules: [],
    });
  });

  it("saves knowledge through upsertKnowledgeDocument (chunked, no duplicates on re-approve)", async () => {
    const res = await post({ action: "approve", proposal });
    expect(res.status).toBe(200);
    expect(mocks.knowledgeCreate).not.toHaveBeenCalled();
    expect(mocks.upsertKnowledgeDocument).toHaveBeenCalledTimes(1);
    expect(mocks.upsertKnowledgeDocument).toHaveBeenCalledWith({
      organisationId: "org_a",
      title: "What we sell",
      category: "business",
      content: "AI automation systems for UK SMEs.",
      tags: ["setup-assistant"],
    });
    expect(mocks.agentUpdate.mock.calls[0]![0].data).toMatchObject({
      brandTone: "friendly, direct",
      qualificationQuestions: proposal.qualificationQuestions,
    });
    expect(mocks.qualificationUpsert).toHaveBeenCalledTimes(1);
    expect((await res.json()).saved).toEqual({
      agentUpdated: true,
      knowledgeDocuments: 1,
      qualificationFields: 1,
    });
  });

  it("never overwrites a hand-written doc with the same title — saves under a distinct title", async () => {
    mocks.knowledgeFindMany.mockImplementation(async ({ where }: { where: { title: string } }) =>
      where.title === "What we sell" ? [{ tags: ["pricing"] }] : [],
    );
    const res = await post({ action: "approve", proposal });
    expect(res.status).toBe(200);
    expect(mocks.knowledgeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organisationId: "org_a", title: "What we sell" } }),
    );
    expect(mocks.upsertKnowledgeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: "What we sell (Setup Assistant)", tags: ["setup-assistant"] }),
    );
  });

  it("numbers the distinct title when '(Setup Assistant)' is also a hand-written doc", async () => {
    mocks.knowledgeFindMany.mockImplementation(async ({ where }: { where: { title: string } }) =>
      where.title === "What we sell" || where.title === "What we sell (Setup Assistant)"
        ? [{ tags: [] }]
        : [],
    );
    await post({ action: "approve", proposal });
    expect(mocks.upsertKnowledgeDocument.mock.calls[0]![0].title).toBe("What we sell (Setup Assistant 2)");
  });

  it("re-approving updates its own earlier doc under the plain title", async () => {
    mocks.knowledgeFindMany.mockResolvedValue([{ tags: ["setup-assistant"] }]);
    await post({ action: "approve", proposal });
    expect(mocks.upsertKnowledgeDocument.mock.calls[0]![0].title).toBe("What we sell");
  });

  it("does not treat a knowledge-gap doc with the same title as its own", async () => {
    mocks.knowledgeFindMany.mockImplementation(async ({ where }: { where: { title: string } }) =>
      where.title === "What we sell" ? [{ tags: ["knowledge-gap"] }] : [],
    );
    await post({ action: "approve", proposal });
    expect(mocks.upsertKnowledgeDocument.mock.calls[0]![0].title).toBe("What we sell (Setup Assistant)");
  });

  it("rejects a proposal in the wrong shape instead of silently saving nothing", async () => {
    const wrongShape = await post({
      action: "approve",
      proposal: { reply: "x", knowledgeStructure: "not-an-array" },
    });
    expect(wrongShape.status).toBe(400);
    const decisionShaped = await post({
      action: "approve",
      proposal: { reply: "Hi!", intent: { primary: "other" } },
    });
    expect(decisionShaped.status).toBe(400);
    expect(mocks.upsertKnowledgeDocument).not.toHaveBeenCalled();
    expect(mocks.agentUpdate).not.toHaveBeenCalled();
  });
});
