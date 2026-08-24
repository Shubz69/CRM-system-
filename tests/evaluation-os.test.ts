/**
 * Phase 17 — Evaluation / learning platform tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const versionCreate = vi.fn();
  const versionFindFirst = vi.fn();
  const calibrationCreate = vi.fn();
  const calibrationFindMany = vi.fn();
  const auditCreate = vi.fn();
  return {
    prisma: {
      versionPerformanceSnapshot: {
        create: versionCreate,
        findFirst: versionFindFirst,
      },
      confidenceCalibrationSample: {
        create: calibrationCreate,
        findMany: calibrationFindMany,
      },
      auditLog: { create: auditCreate },
      __mocks: {
        versionCreate,
        versionFindFirst,
        calibrationCreate,
        calibrationFindMany,
        auditCreate,
      },
    },
  };
});

vi.mock("@/services/audit", () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import {
  assertNoSecretsInFixture,
  listBuiltinEvalFixtures,
  runDeterministicEvalSuite,
  runShadowEvaluation,
  scoreSchemaValidity,
  scoreTenantCorrectness,
  scoreCitationCoverage,
  shouldAutoPromoteFromSingleRun,
  assertRolloutTransition,
  transitionRolloutState,
  recordVersionPerformanceSnapshot,
  getCalibrationHitRateByBand,
  recordConfidenceCalibrationSample,
  assertNotProductionCodePath,
  getLearningSafetyPolicy,
  LearningSafetyError,
  SIGNAL_USER_PREFERENCE,
  SIGNAL_EMPIRICAL_PERFORMANCE,
} from "@/services/evaluation";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/services/audit";

type Mocks = {
  versionCreate: ReturnType<typeof vi.fn>;
  versionFindFirst: ReturnType<typeof vi.fn>;
  calibrationCreate: ReturnType<typeof vi.fn>;
  calibrationFindMany: ReturnType<typeof vi.fn>;
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

describe("Phase 17 evaluation datasets", () => {
  it("builtin fixtures have no secrets and label signal kinds", () => {
    const fixtures = listBuiltinEvalFixtures();
    expect(fixtures.length).toBeGreaterThan(3);
    for (const f of fixtures) {
      expect(() => assertNoSecretsInFixture(f.input)).not.toThrow();
      expect([SIGNAL_USER_PREFERENCE, SIGNAL_EMPIRICAL_PERFORMANCE]).toContain(f.signalKind);
    }
    expect(fixtures.some((f) => f.signalKind === SIGNAL_USER_PREFERENCE)).toBe(true);
    expect(fixtures.some((f) => f.signalKind === SIGNAL_EMPIRICAL_PERFORMANCE)).toBe(true);
  });

  it("rejects secret-like fixture keys", () => {
    expect(() =>
      assertNoSecretsInFixture({ api_key: "x", title: "ok" }),
    ).toThrow(/secret/i);
  });
});

describe("Phase 17 deterministic scorers", () => {
  it("schema validity checks required fields", () => {
    const ok = scoreSchemaValidity({
      schema: "opportunity_v1",
      payload: { title: "T", organisationId: "o1", status: "OPEN" },
    });
    expect(ok.passed).toBe(true);
    const bad = scoreSchemaValidity({
      schema: "opportunity_v1",
      payload: { organisationId: "o1", status: "OPEN" },
    });
    expect(bad.passed).toBe(false);
  });

  it("tenant correctness detects cross-tenant citations", () => {
    const leak = scoreTenantCorrectness({
      requestOrganisationId: "org_a",
      outputOrganisationId: "org_a",
      citedOrganisationIds: ["org_a", "org_b"],
    });
    expect(leak.passed).toBe(false);
    const ok = scoreTenantCorrectness({
      requestOrganisationId: "org_a",
      outputOrganisationId: "org_a",
      citedOrganisationIds: ["org_a"],
    });
    expect(ok.passed).toBe(true);
  });

  it("citation coverage is a real fraction", () => {
    const partial = scoreCitationCoverage({
      claims: [
        { id: "1", citationIds: ["e1"] },
        { id: "2", citationIds: [] },
      ],
    });
    expect(partial.score).toBe(0.5);
    expect(partial.passed).toBe(false);
  });

  it("deterministic suite passes builtin fixtures", () => {
    const result = runDeterministicEvalSuite();
    expect(result.passed).toBe(true);
    expect(result.maturity).toBe("WORKING");
    expect(result.signalKindsDocumented).toContain(SIGNAL_USER_PREFERENCE);
  });
});

describe("Phase 17 shadow mode", () => {
  it("proposes without external actions and blocks forbidden attempts", () => {
    const ok = runShadowEvaluation({ candidateKey: "cand_v1" });
    expect(ok.mode).toBe("shadow");
    expect(ok.externalActionsDisabled).toBe(true);
    expect(ok.passed).toBe(true);
    expect(ok.caseResults.every((c) => c.proposal != null)).toBe(true);

    const blocked = runShadowEvaluation({
      candidateKey: "cand_v1",
      attemptedExternalActions: ["publish"],
    });
    expect(blocked.passed).toBe(false);
    expect(blocked.message).toMatch(/blocked/i);
  });
});

describe("Phase 17 canary / promote safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never auto-promotes from a single good run", () => {
    expect(shouldAutoPromoteFromSingleRun(true)).toBe(false);
  });

  it("blocks invalid rollout transitions", () => {
    expect(() => assertRolloutTransition("CURRENT", "PROMOTED")).toThrow(/Invalid rollout/);
    expect(() => assertRolloutTransition("CANARY", "PROMOTED")).not.toThrow();
  });

  it("requires confirmPromote for PROMOTED", async () => {
    mocks.versionFindFirst.mockResolvedValue({
      rolloutState: "CANARY",
      sampleSize: 5,
    });
    await expect(
      transitionRolloutState({
        organisationId: "org_1",
        artifactKind: "agent_prompt",
        artifactKey: "default",
        version: "2",
        to: "PROMOTED",
      }),
    ).rejects.toThrow(/confirmPromote/);
  });

  it("records snapshot without promoting", async () => {
    mocks.versionCreate.mockResolvedValue({
      id: "snap_1",
      rolloutState: "CANDIDATE",
      sampleSize: 0,
    });
    const row = await recordVersionPerformanceSnapshot({
      organisationId: "org_1",
      artifactKind: "agent_prompt",
      artifactKey: "default",
      version: "2",
      sampleSize: 0,
    });
    expect(row.rolloutState).toBe("CANDIDATE");
    expect(mocks.versionCreate).toHaveBeenCalled();
  });

  it("audits explicit promote", async () => {
    mocks.versionFindFirst.mockResolvedValue({
      rolloutState: "CANARY",
      sampleSize: 10,
    });
    mocks.versionCreate.mockResolvedValue({
      id: "snap_2",
      rolloutState: "PROMOTED",
    });
    await transitionRolloutState({
      organisationId: "org_1",
      artifactKind: "agent_prompt",
      artifactKey: "default",
      version: "2",
      to: "PROMOTED",
      confirmPromote: true,
      reason: "canary window complete",
    });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "evaluation.version.promoted" }),
    );
  });
});

describe("Phase 17 calibration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports null hitRate when no resolved outcomes", async () => {
    mocks.calibrationFindMany.mockResolvedValue([
      { statedBand: "HIGH", wasCorrect: null },
      { statedBand: "HIGH", wasCorrect: null },
    ]);
    const report = await getCalibrationHitRateByBand({ organisationId: "org_1" });
    expect(report.signalKind).toBe(SIGNAL_EMPIRICAL_PERFORMANCE);
    expect(report.byBand[0]?.hitRate).toBeNull();
    expect(report.recommendation).toMatch(/do not/i);
  });

  it("computes hit-rate by band when samples exist", async () => {
    mocks.calibrationFindMany.mockResolvedValue([
      { statedBand: "HIGH", wasCorrect: true },
      { statedBand: "HIGH", wasCorrect: false },
      { statedBand: "LOW", wasCorrect: true },
    ]);
    const report = await getCalibrationHitRateByBand({ organisationId: "org_1" });
    const high = report.byBand.find((b) => b.statedBand === "HIGH");
    expect(high?.hitRate).toBe(0.5);
    expect(report.totalSamples).toBe(3);
  });

  it("records calibration sample", async () => {
    mocks.calibrationCreate.mockResolvedValue({ id: "cal_1" });
    await recordConfidenceCalibrationSample({
      organisationId: "org_1",
      subjectKind: "opportunity",
      subjectId: "opp_1",
      statedBand: "MEDIUM",
      wasCorrect: true,
    });
    expect(mocks.calibrationCreate).toHaveBeenCalled();
  });
});

describe("Phase 17 learning safety", () => {
  it("blocks production code paths", () => {
    expect(() => assertNotProductionCodePath("src/services/foo.ts")).toThrow(
      LearningSafetyError,
    );
    const policy = getLearningSafetyPolicy();
    expect(policy.allowedTargets).toContain("prompt_weights");
    expect(policy.forbiddenPaths).toContain("src/");
  });
});
