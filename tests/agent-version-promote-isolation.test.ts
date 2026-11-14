/**
 * Agent-version candidates: agentConfigurationId comes from the request body, so create/promote
 * must only touch the session organisation's config, and never promote provider/model routing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AgentVersionCandidateStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  candidateFindFirst: vi.fn(),
  candidateCreate: vi.fn(),
  candidateUpdate: vi.fn(),
  configFindFirst: vi.fn(),
  configUpdate: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    agentVersionCandidate: {
      findFirst: (...args: unknown[]) => mocks.candidateFindFirst(...args),
      create: (...args: unknown[]) => mocks.candidateCreate(...args),
      update: (...args: unknown[]) => mocks.candidateUpdate(...args),
    },
    agentConfiguration: {
      findFirst: (...args: unknown[]) => mocks.configFindFirst(...args),
      update: (...args: unknown[]) => mocks.configUpdate(...args),
    },
  },
}));

vi.mock("@/kernel", () => ({
  ensureBuiltinToolsRegistered: vi.fn(),
  evaluateToolPolicy: vi.fn(() => ({ effect: "require_approval", reason: "ok" })),
}));

vi.mock("@/lib/session", () => ({
  requirePermission: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: (...args: unknown[]) => mocks.writeAuditLog(...args),
}));

import {
  createAgentVersionCandidate,
  promoteAgentVersionCandidate,
} from "@/services/learning-os";
import { PATCH, POST } from "@/app/api/learning/agent-versions/route";

function request(method: "POST" | "PATCH", body: unknown) {
  return new NextRequest("http://localhost/api/learning/agent-versions", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const passedCandidate = (overrides: Record<string, unknown> = {}) => ({
  id: "cand_1",
  organisationId: "org_a",
  status: AgentVersionCandidateStatus.PASSED,
  configSnapshot: { brandTone: "warm", model: "evil-model", aiProvider: "openai" },
  agentConfigurationId: "cfg_other_org",
  ...overrides,
});

describe("promoteAgentVersionCandidate — tenant + routing guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidateUpdate.mockImplementation(async ({ data }: { data: object }) => ({
      id: "cand_1",
      ...data,
    }));
  });

  it("refuses to write another organisation's AgentConfiguration", async () => {
    mocks.candidateFindFirst.mockResolvedValue(passedCandidate());
    mocks.configFindFirst.mockResolvedValue(null);
    await expect(
      promoteAgentVersionCandidate({ organisationId: "org_a", candidateId: "cand_1" }),
    ).rejects.toThrow(/Agent configuration not found/);
    expect(mocks.configFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cfg_other_org", organisationId: "org_a" } }),
    );
    expect(mocks.configUpdate).not.toHaveBeenCalled();
    expect(mocks.candidateUpdate).not.toHaveBeenCalled();
  });

  it("promotes behaviour fields only — never aiProvider/model", async () => {
    mocks.candidateFindFirst.mockResolvedValue(passedCandidate({ agentConfigurationId: "cfg_a" }));
    mocks.configFindFirst.mockResolvedValue({ id: "cfg_a" });
    await promoteAgentVersionCandidate({ organisationId: "org_a", candidateId: "cand_1" });
    const call = mocks.configUpdate.mock.calls[0]![0] as { where: unknown; data: Record<string, unknown> };
    expect(call.where).toEqual({ id: "cfg_a" });
    expect(call.data.brandTone).toBe("warm");
    expect(call.data).not.toHaveProperty("model");
    expect(call.data).not.toHaveProperty("aiProvider");
  });

  it("create rejects a foreign agentConfigurationId and strips provider/model from the snapshot", async () => {
    mocks.configFindFirst.mockResolvedValueOnce(null);
    await expect(
      createAgentVersionCandidate({
        organisationId: "org_a",
        label: "v2",
        configSnapshot: {},
        agentConfigurationId: "cfg_other_org",
      }),
    ).rejects.toThrow(/Agent configuration not found/);
    expect(mocks.candidateCreate).not.toHaveBeenCalled();

    mocks.candidateCreate.mockResolvedValue({ id: "cand_2" });
    await createAgentVersionCandidate({
      organisationId: "org_a",
      label: "v2",
      configSnapshot: { brandTone: "warm", model: "m", aiProvider: "openai" },
    });
    expect(mocks.candidateCreate.mock.calls[0]![0].data.configSnapshot).toEqual({ brandTone: "warm" });
  });
});

describe("/api/learning/agent-versions — 404 for foreign configs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POST with another org's agentConfigurationId returns 404", async () => {
    mocks.configFindFirst.mockResolvedValue(null);
    const res = await POST(
      request("POST", { label: "v2", configSnapshot: {}, agentConfigurationId: "cfg_other_org" }),
    );
    expect(res.status).toBe(404);
  });

  it("PATCH promote into another org's config returns 404", async () => {
    mocks.candidateFindFirst.mockResolvedValue(passedCandidate());
    mocks.configFindFirst.mockResolvedValue(null);
    const res = await PATCH(request("PATCH", { action: "promote", id: "cand_1" }));
    expect(res.status).toBe(404);
    expect(mocks.configUpdate).not.toHaveBeenCalled();
  });
});
