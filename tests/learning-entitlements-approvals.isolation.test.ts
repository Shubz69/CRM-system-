/**
 * Isolation + honesty for Learning, Entitlements, Approvals (continuous hardening).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => {
  const approvalFindFirst = vi.fn();
  const approvalUpdate = vi.fn();
  const experimentFindFirst = vi.fn();
  const experimentUpdate = vi.fn();
  const candidateFindFirst = vi.fn();
  const candidateUpdate = vi.fn();
  const candidateUpdateMany = vi.fn();
  const orgFindUnique = vi.fn();
  const entitlementFindMany = vi.fn();
  const usageMeterFindUnique = vi.fn();
  const usageRecordCount = vi.fn();
  return {
    prisma: {
      approvalRequest: { findFirst: approvalFindFirst, update: approvalUpdate },
      experiment: { findFirst: experimentFindFirst, update: experimentUpdate },
      agentVersionCandidate: {
        findFirst: candidateFindFirst,
        update: candidateUpdate,
        updateMany: candidateUpdateMany,
      },
      organisation: { findUnique: orgFindUnique },
      entitlement: { findMany: entitlementFindMany },
      usageMeter: { findUnique: usageMeterFindUnique },
      usageRecord: { count: usageRecordCount },
      __mocks: {
        approvalFindFirst,
        approvalUpdate,
        experimentFindFirst,
        experimentUpdate,
        candidateFindFirst,
        candidateUpdate,
        orgFindUnique,
        entitlementFindMany,
        usageMeterFindUnique,
        usageRecordCount,
      },
    },
  };
});

vi.mock("@/kernel", () => ({
  ensureBuiltinToolsRegistered: vi.fn(),
  evaluateToolPolicy: vi.fn(() => ({ effect: "require_approval", reason: "ok" })),
}));

vi.mock("@/services/automations", () => ({
  executeAction: vi.fn(),
}));

import { decideApprovalRequest } from "@/services/automation-os";
import {
  completeExperiment,
  promoteAgentVersionCandidate,
  startExperiment,
} from "@/services/learning-os";
import {
  assertEntitlement,
  EntitlementDeniedError,
  MeterLimitExceededError,
} from "@/services/entitlements";
import { prisma } from "@/lib/db";
import { executeAction } from "@/services/automations";
import { AgentVersionCandidateStatus, ApprovalRequestStatus } from "@prisma/client";

type Mocks = {
  approvalFindFirst: ReturnType<typeof vi.fn>;
  approvalUpdate: ReturnType<typeof vi.fn>;
  experimentFindFirst: ReturnType<typeof vi.fn>;
  experimentUpdate: ReturnType<typeof vi.fn>;
  candidateFindFirst: ReturnType<typeof vi.fn>;
  candidateUpdate: ReturnType<typeof vi.fn>;
  orgFindUnique: ReturnType<typeof vi.fn>;
  entitlementFindMany: ReturnType<typeof vi.fn>;
  usageMeterFindUnique: ReturnType<typeof vi.fn>;
  usageRecordCount: ReturnType<typeof vi.fn>;
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

describe("Approvals — org isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decideApprovalRequest does not find another org's approval", async () => {
    mocks.approvalFindFirst.mockResolvedValue(null);
    await expect(
      decideApprovalRequest({
        organisationId: "org_a",
        approvalId: "appr_b",
        decision: "APPROVED",
      }),
    ).rejects.toThrow(/not found/i);
    expect(mocks.approvalFindFirst).toHaveBeenCalledWith({
      where: { id: "appr_b", organisationId: "org_a" },
    });
    expect(mocks.approvalUpdate).not.toHaveBeenCalled();
  });

  it("refuses to execute when payload.context.organisationId mismatches", async () => {
    mocks.approvalFindFirst.mockResolvedValue({
      id: "appr_1",
      organisationId: "org_a",
      status: ApprovalRequestStatus.PENDING,
      payload: {
        context: {
          organisationId: "org_EVIL",
          triggerType: "lead_qualified",
        },
        actions: [{ type: "notify_team", message: "hi" }],
      },
    });
    mocks.approvalUpdate.mockResolvedValue({});

    await expect(
      decideApprovalRequest({
        organisationId: "org_a",
        approvalId: "appr_1",
        decision: "APPROVED",
      }),
    ).rejects.toThrow(/organisation mismatch/i);

    expect(executeAction).not.toHaveBeenCalled();
    expect(mocks.approvalUpdate).not.toHaveBeenCalled();
  });

  it("runs actions only when payload org matches", async () => {
    mocks.approvalFindFirst.mockResolvedValue({
      id: "appr_1",
      organisationId: "org_a",
      status: ApprovalRequestStatus.PENDING,
      payload: {
        context: {
          organisationId: "org_a",
          triggerType: "lead_qualified",
        },
        actions: [{ type: "notify_team", message: "hi" }],
      },
    });
    mocks.approvalUpdate.mockResolvedValue({});
    vi.mocked(executeAction).mockResolvedValue(undefined);

    const result = await decideApprovalRequest({
      organisationId: "org_a",
      approvalId: "appr_1",
      decision: "APPROVED",
    });
    expect(result.actionsRun).toBe(1);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });
});

describe("Learning — org isolation + promote gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("startExperiment rejects wrong organisationId", async () => {
    mocks.experimentFindFirst.mockResolvedValue(null);
    await expect(
      startExperiment({ organisationId: "org_a", experimentId: "exp_b" }),
    ).rejects.toThrow(/not found/i);
    expect(mocks.experimentUpdate).not.toHaveBeenCalled();
  });

  it("completeExperiment rejects wrong organisationId", async () => {
    mocks.experimentFindFirst.mockResolvedValue(null);
    await expect(
      completeExperiment({
        organisationId: "org_a",
        experimentId: "exp_b",
        sampleSize: 0,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("promoteAgentVersionCandidate blocks non-PASSED status", async () => {
    mocks.candidateFindFirst.mockResolvedValue({
      id: "cand_1",
      organisationId: "org_a",
      status: AgentVersionCandidateStatus.FAILED,
      configSnapshot: {},
      agentConfigurationId: "cfg_1",
    });
    await expect(
      promoteAgentVersionCandidate({ organisationId: "org_a", candidateId: "cand_1" }),
    ).rejects.toThrow(/PASS/i);
    expect(mocks.candidateUpdate).not.toHaveBeenCalled();
  });

  it("promoteAgentVersionCandidate rejects cross-org candidate", async () => {
    mocks.candidateFindFirst.mockResolvedValue(null);
    await expect(
      promoteAgentVersionCandidate({ organisationId: "org_a", candidateId: "cand_b" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("Entitlements — denial + meter limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("assertEntitlement throws when capability disabled", async () => {
    mocks.orgFindUnique.mockResolvedValue({ plan: "standard", entitlementSnapshot: {} });
    mocks.entitlementFindMany.mockResolvedValue([
      {
        capability: "research",
        enabled: false,
        limitValue: 50,
      },
    ]);
    await expect(assertEntitlement("org_a", "research")).rejects.toBeInstanceOf(
      EntitlementDeniedError,
    );
  });

  it("assertEntitlement throws MeterLimitExceeded when at limit", async () => {
    mocks.orgFindUnique.mockResolvedValue({ plan: "standard", entitlementSnapshot: {} });
    mocks.entitlementFindMany.mockResolvedValue([
      {
        capability: "research",
        enabled: true,
        limitValue: 10,
      },
    ]);
    mocks.usageMeterFindUnique.mockResolvedValue({
      quantity: 10,
      periodStart: new Date(),
    });
    await expect(assertEntitlement("org_a", "research")).rejects.toBeInstanceOf(
      MeterLimitExceededError,
    );
  });

  it("assertEntitlement allows under limit", async () => {
    mocks.orgFindUnique.mockResolvedValue({ plan: "standard", entitlementSnapshot: {} });
    mocks.entitlementFindMany.mockResolvedValue([]);
    mocks.usageMeterFindUnique.mockResolvedValue({
      quantity: 5,
      periodStart: new Date(),
    });
    // plan default research limit 50
    const result = await assertEntitlement("org_a", "research");
    expect(result.ok).toBe(true);
    expect(result.used).toBe(5);
    expect(result.limit).toBe(50);
  });
});
