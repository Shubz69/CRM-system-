import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => {
  const organisationAgentRetention = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  };
  const toolCall = { updateMany: vi.fn() };
  const agentStep = { findMany: vi.fn(), updateMany: vi.fn() };
  const agentRun = { findMany: vi.fn(), updateMany: vi.fn() };
  return {
    prisma: {
      organisationAgentRetention,
      toolCall,
      agentStep,
      agentRun,
      $queryRaw: vi.fn(),
      __mocks: { organisationAgentRetention, toolCall, agentStep, agentRun },
    },
  };
});

import {
  DEFAULT_AGENT_RETENTION,
  getOrganisationAgentRetention,
  pruneAgentArtifactsForOrganisation,
  setOrganisationAgentRetention,
  STEPS_CLEARED_MESSAGE,
} from "@/services/agent-retention";
import { prisma } from "@/lib/db";

type Mocks = {
  organisationAgentRetention: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  toolCall: { updateMany: ReturnType<typeof vi.fn> };
  agentStep: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  agentRun: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

describe("agent retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organisationAgentRetention.findUnique.mockResolvedValue(null);
    mocks.toolCall.updateMany.mockResolvedValue({ count: 0 });
    mocks.agentStep.findMany.mockResolvedValue([]);
    mocks.agentStep.updateMany.mockResolvedValue({ count: 0 });
    mocks.agentRun.findMany.mockResolvedValue([]);
    mocks.agentRun.updateMany.mockResolvedValue({ count: 0 });
  });

  it("returns sensible defaults when org has no retention row", async () => {
    await expect(getOrganisationAgentRetention("org_1")).resolves.toEqual(DEFAULT_AGENT_RETENTION);
  });

  it("rejects invalid retention windows", async () => {
    await expect(
      setOrganisationAgentRetention({
        organisationId: "org_1",
        stepFullDetailDays: 90,
        stepSkeletonAfterDays: 30,
      }),
    ).rejects.toThrow(/stepSkeletonAfterDays/);
  });

  it("prunes only the requested organisationId", async () => {
    mocks.toolCall.updateMany.mockResolvedValue({ count: 2 });
    const result = await pruneAgentArtifactsForOrganisation("org_a");
    expect(mocks.toolCall.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organisationId: "org_a" }),
      }),
    );
    expect(result.organisationId).toBe("org_a");
    expect(result.toolCallsCleared).toBe(2);
  });

  it("exposes the plain-English cleared-steps copy for the UI", () => {
    expect(STEPS_CLEARED_MESSAGE).toMatch(/brief is saved/i);
    expect(STEPS_CLEARED_MESSAGE).toMatch(/30 days/);
  });
});
