/**
 * Phase 18 — Enterprise ops tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemberRole } from "@prisma/client";

vi.mock("@/lib/db", () => {
  const sloCreate = vi.fn();
  const sloFindFirst = vi.fn();
  const costCreate = vi.fn();
  const costFindMany = vi.fn();
  const agentRunFindFirst = vi.fn();
  const domainEventCount = vi.fn();
  const domainEventFindFirst = vi.fn();
  const publishingJobCount = vi.fn();
  const continuousCollectionRunCount = vi.fn();
  const agentMissionCount = vi.fn();
  const agentStepCount = vi.fn();
  const auditLogCount = vi.fn();
  const failedJobCount = vi.fn();
  const calibrationCount = vi.fn();
  const retentionFindUnique = vi.fn();
  const queryRaw = vi.fn(async () => [{ "?column?": 1 }]);
  return {
    prisma: {
      operationalSloSnapshot: { create: sloCreate, findFirst: sloFindFirst },
      costOutcomeLink: { create: costCreate, findMany: costFindMany },
      agentRun: { findFirst: agentRunFindFirst },
      domainEvent: { count: domainEventCount, findFirst: domainEventFindFirst },
      publishingJob: { count: publishingJobCount },
      continuousCollectionRun: { count: continuousCollectionRunCount },
      agentMission: { count: agentMissionCount },
      agentStep: { count: agentStepCount },
      auditLog: { count: auditLogCount, create: vi.fn() },
      failedJob: { count: failedJobCount },
      confidenceCalibrationSample: { count: calibrationCount },
      organisationAgentRetention: { findUnique: retentionFindUnique },
      $queryRaw: queryRaw,
      __mocks: {
        sloCreate,
        costCreate,
        agentRunFindFirst,
        domainEventCount,
        domainEventFindFirst,
        publishingJobCount,
        continuousCollectionRunCount,
        agentMissionCount,
        agentStepCount,
        auditLogCount,
        failedJobCount,
        calibrationCount,
        retentionFindUnique,
        queryRaw,
      },
    },
  };
});

vi.mock("@/jobs/redis", () => ({
  pingRedis: vi.fn(async () => true),
}));

vi.mock("@/services/audit", () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import {
  captureOperationalSloSnapshot,
  SLO_MATURITY_NOTE,
  recordCostOutcomeLink,
  CostOutcomeHonestyError,
  getCostOutcomePolicy,
  assertStrongerThanRead,
  assertEnterprisePermission,
  roleHasEnterprisePermission,
  getRbacMatrixDocumentation,
  HIGH_RISK_PERMISSION_KEYS,
  listRetentionPolicies,
  dryRunRetentionPurge,
  executeRetentionPurge,
  getSsoScimReadiness,
  isSsoLive,
  SSO_SCIM_MATURITY,
  getEnterpriseOpsPanel,
  getProductionHealth,
} from "@/services/enterprise-ops";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";

type Mocks = {
  sloCreate: ReturnType<typeof vi.fn>;
  costCreate: ReturnType<typeof vi.fn>;
  agentRunFindFirst: ReturnType<typeof vi.fn>;
  domainEventCount: ReturnType<typeof vi.fn>;
  domainEventFindFirst: ReturnType<typeof vi.fn>;
  publishingJobCount: ReturnType<typeof vi.fn>;
  continuousCollectionRunCount: ReturnType<typeof vi.fn>;
  agentMissionCount: ReturnType<typeof vi.fn>;
  agentStepCount: ReturnType<typeof vi.fn>;
  auditLogCount: ReturnType<typeof vi.fn>;
  failedJobCount: ReturnType<typeof vi.fn>;
  calibrationCount: ReturnType<typeof vi.fn>;
  retentionFindUnique: ReturnType<typeof vi.fn>;
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

describe("Phase 18 SLO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentRunFindFirst.mockResolvedValue(null);
    mocks.domainEventCount.mockResolvedValue(0);
    mocks.domainEventFindFirst.mockResolvedValue(null);
    mocks.publishingJobCount.mockResolvedValue(0);
    mocks.continuousCollectionRunCount.mockResolvedValue(0);
    mocks.agentMissionCount.mockResolvedValue(0);
    mocks.sloCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "slo_1",
      ...data,
    }));
  });

  it("captures snapshot with FOUNDATION maturity and null publish rate when empty", async () => {
    const snap = await captureOperationalSloSnapshot({ organisationId: "org_1" });
    expect(snap.maturityNote).toBe(SLO_MATURITY_NOTE);
    expect(snap.contractualSlo).toBe(false);
    expect(snap.indicators.publishSuccessRate.rate).toBeNull();
    expect(snap.indicators.continuousIntelRuns.count).toBe(0);
    expect(snap.indicators.publishingDispatching.count).toBe(0);
    expect(snap.indicators.missionWaitingApproval.count).toBe(0);
    expect(mocks.sloCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ maturityNote: "FOUNDATION" }),
      }),
    );
  });

  it("reports publish rate only from real terminal counts", async () => {
    mocks.publishingJobCount
      .mockResolvedValueOnce(3) // published
      .mockResolvedValueOnce(1) // failed
      .mockResolvedValueOnce(0); // dispatching
    const snap = await captureOperationalSloSnapshot({ organisationId: "org_1" });
    expect(snap.indicators.publishSuccessRate.rate).toBe(0.75);
  });
});

describe("Phase 18 cost outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.costCreate.mockResolvedValue({
      id: "col_1",
      costCents: 100,
      costKind: "ai_run",
      outcomeKind: "mission",
      attribution: "UNKNOWN",
    });
  });

  it("defaults attribution UNKNOWN and audits", async () => {
    await recordCostOutcomeLink({
      organisationId: "org_1",
      costCents: 100,
      costKind: "ai_run",
      outcomeKind: "mission",
    });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "enterprise.cost_outcome.recorded" }),
    );
    expect(getCostOutcomePolicy().attributions).toContain("DIRECT");
  });

  it("never invents revenue and requires DIRECT evidence", async () => {
    await expect(
      recordCostOutcomeLink({
        organisationId: "org_1",
        costCents: 10,
        costKind: "ai_run",
        outcomeKind: "deal",
        metadata: { revenueCents: 99999 },
      }),
    ).rejects.toBeInstanceOf(CostOutcomeHonestyError);

    await expect(
      recordCostOutcomeLink({
        organisationId: "org_1",
        costCents: 10,
        costKind: "ai_run",
        outcomeKind: "deal",
        attribution: "DIRECT",
      }),
    ).rejects.toBeInstanceOf(CostOutcomeHonestyError);
  });
});

describe("Phase 18 RBAC matrix", () => {
  it("documents high-risk keys stronger than read", () => {
    const docs = getRbacMatrixDocumentation();
    expect(docs.maturity).toBe("WORKING");
    expect(HIGH_RISK_PERMISSION_KEYS.length).toBeGreaterThan(5);
    expect(roleHasEnterprisePermission(MemberRole.READ_ONLY, "crm:read")).toBe(true);
    expect(roleHasEnterprisePermission(MemberRole.READ_ONLY, "crm:write")).toBe(false);
  });

  it("blocks high-risk for read-only / weak roles", () => {
    expect(() =>
      assertStrongerThanRead(MemberRole.READ_ONLY, "credentials:manage"),
    ).toThrow(/Forbidden/);
    expect(() =>
      assertStrongerThanRead(MemberRole.ANALYST, "publishing:execute"),
    ).toThrow(/stronger than read/);
    expect(() =>
      assertEnterprisePermission(MemberRole.OWNER, "ai:configure"),
    ).not.toThrow();
  });
});

describe("Phase 18 retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retentionFindUnique.mockResolvedValue(null);
    mocks.agentStepCount.mockResolvedValue(2);
    mocks.auditLogCount.mockResolvedValue(5);
  });

  it("lists policies and dry-runs without deleting", async () => {
    const policies = listRetentionPolicies();
    expect(policies.some((p) => p.id === "audit_log" && p.maturity === "FOUNDATION")).toBe(
      true,
    );
    const dry = await dryRunRetentionPurge({
      organisationId: "org_1",
      policyId: "agent_run_detail",
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.eligibleCount).toBe(2);
  });

  it("refuses FOUNDATION destructive purge", async () => {
    await expect(
      executeRetentionPurge({
        organisationId: "org_1",
        policyId: "audit_log",
        confirmDestructive: true,
      }),
    ).rejects.toThrow(/FOUNDATION/);
  });
});

describe("Phase 18 SSO/SCIM stubs", () => {
  it("is FOUNDATION and never live", () => {
    const readiness = getSsoScimReadiness();
    expect(readiness.maturity).toBe(SSO_SCIM_MATURITY);
    expect(readiness.liveProvidersConfigured).toBe(false);
    expect(isSsoLive("sso_saml_stub")).toBe(false);
    expect(readiness.sso.every((s) => s.status === "not_configured")).toBe(true);
  });
});

describe("Phase 18 enterprise ops panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentRunFindFirst.mockResolvedValue(null);
    mocks.domainEventCount.mockResolvedValue(1);
    mocks.domainEventFindFirst.mockResolvedValue(null);
    mocks.publishingJobCount.mockResolvedValue(0);
    mocks.continuousCollectionRunCount.mockResolvedValue(0);
    mocks.agentMissionCount.mockResolvedValue(2);
  });

  it("returns SLO FOUNDATION panel without fake charts", async () => {
    const panel = await getEnterpriseOpsPanel("org_1");
    expect(panel.slo.maturityNote).toBe("FOUNDATION");
    expect(panel.slo.contractualSlo).toBe(false);
    expect(panel.ssoScim.maturity).toBe("FOUNDATION");
    expect(panel.quality.publishHealth.rate).toBeNull();
    expect(panel.slo.indicators.missionWaitingApproval.count).toBe(2);
    expect(panel.productionHealth?.maturity).toBe("FOUNDATION");
    expect(panel.productionHealth?.ok).toBe(true);
  });
});

describe("Phase 18 production health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentRunFindFirst.mockResolvedValue(null);
    mocks.domainEventCount.mockResolvedValue(0);
    mocks.domainEventFindFirst.mockResolvedValue(null);
    mocks.publishingJobCount.mockResolvedValue(0);
  });

  it("reports FOUNDATION health without paid provider probes", async () => {
    const health = await getProductionHealth();
    expect(health.maturity).toBe("FOUNDATION");
    expect(health.ok).toBe(true);
    expect(health.database.ok).toBe(true);
    expect(health.note).toMatch(/no paid provider/i);
  });
});
