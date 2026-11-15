/**
 * Learning Lab "Promote" used to answer 500 when the workspace had no AI agent set up
 * (e.g. the platform workspace) or the candidate hadn't passed — those are 409s the user
 * can act on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AgentVersionCandidateStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  candidateFindFirst: vi.fn(),
  candidateUpdate: vi.fn(),
  configFindFirst: vi.fn(),
  configUpdate: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    agentVersionCandidate: {
      findFirst: (...args: unknown[]) => mocks.candidateFindFirst(...args),
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
  requirePermission: vi.fn(async () => ({ organisationId: "org_platform", userId: "admin_1" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));
vi.mock("@/services/audit", () => ({
  writeAuditLog: (...args: unknown[]) => mocks.writeAuditLog(...args),
}));

import { PATCH } from "@/app/api/learning/agent-versions/route";

function promote(id = "cand_1") {
  return PATCH(
    new NextRequest("http://localhost/api/learning/agent-versions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "promote", id }),
    }),
  );
}

const candidate = (status: AgentVersionCandidateStatus) => ({
  id: "cand_1",
  organisationId: "org_platform",
  status,
  configSnapshot: { systemPromptExtra: "Be concise." },
  agentConfigurationId: null,
});

describe("PATCH /api/learning/agent-versions promote", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers 409 with a clear message when the workspace has no agent to promote into", async () => {
    mocks.candidateFindFirst.mockResolvedValue(candidate(AgentVersionCandidateStatus.PASSED));
    mocks.configFindFirst.mockResolvedValue(null);

    const res = await promote();
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/no AI agent set up/i);
    expect(mocks.configUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("answers 409 when the candidate hasn't passed its eval", async () => {
    mocks.candidateFindFirst.mockResolvedValue(candidate(AgentVersionCandidateStatus.FAILED));

    const res = await promote();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/PASS/);
  });

  it("answers 409 when the candidate was already promoted", async () => {
    mocks.candidateFindFirst.mockResolvedValue(candidate(AgentVersionCandidateStatus.PROMOTED));

    const res = await promote();

    expect(res.status).toBe(409);
  });

  it("promotes a passed candidate into the active agent config", async () => {
    mocks.candidateFindFirst.mockResolvedValue(candidate(AgentVersionCandidateStatus.PASSED));
    mocks.configFindFirst.mockResolvedValue({ id: "cfg_1" });
    mocks.configUpdate.mockResolvedValue({ id: "cfg_1" });
    mocks.candidateUpdate.mockResolvedValue({ id: "cand_1", status: "PROMOTED" });

    const res = await promote();

    expect(res.status).toBe(200);
    expect(mocks.configUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cfg_1" },
        data: expect.objectContaining({ systemPromptExtra: "Be concise." }),
      }),
    );
  });
});
