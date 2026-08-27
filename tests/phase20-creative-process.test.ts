import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => {
  const creativeFeatureSet = { findUnique: vi.fn(), upsert: vi.fn() };
  const creativePattern = { upsert: vi.fn() };
  const processDefinition = { upsert: vi.fn() };
  const processTransitionStat = {
    upsert: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  };
  const automationOpportunity = { findFirst: vi.fn(), create: vi.fn() };
  return {
    prisma: {
      creativeFeatureSet,
      creativePattern,
      processDefinition,
      processTransitionStat,
      automationOpportunity,
      __mocks: {
        creativeFeatureSet,
        creativePattern,
        processDefinition,
        processTransitionStat,
        automationOpportunity,
      },
    },
  };
});

import { prisma } from "@/lib/db";
import {
  creativePatternMaturity,
  deriveCreativeFeatures,
  extractCreativeFeatures,
  normalisePatternMetrics,
} from "@/services/creative-genome";
import {
  applyProcessEvent,
  detectAutomationOpportunities,
  reconcileProcessWindow,
} from "@/services/process-twin";

type Mocks = {
  creativeFeatureSet: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  creativePattern: { upsert: ReturnType<typeof vi.fn> };
  processDefinition: { upsert: ReturnType<typeof vi.fn> };
  processTransitionStat: {
    upsert: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  automationOpportunity: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

const mocks = (prisma as unknown as { __mocks: Mocks }).__mocks;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Phase 20G creative genome", () => {
  it("extracts once until the content version changes", async () => {
    const existing = { id: "features_1", contentVersionId: "version_1" };
    mocks.creativeFeatureSet.findUnique.mockResolvedValue(existing);

    await expect(
      extractCreativeFeatures({
        organisationId: "org_1",
        contentPieceId: "content_1",
        contentVersionId: "version_1",
        text: "Book a demo",
      }),
    ).resolves.toBe(existing);
    expect(mocks.creativeFeatureSet.upsert).not.toHaveBeenCalled();

    mocks.creativeFeatureSet.upsert.mockResolvedValue({ contentVersionId: "version_2" });
    await extractCreativeFeatures({
      organisationId: "org_1",
      contentPieceId: "content_1",
      contentVersionId: "version_2",
      text: "Book a demo",
    });
    expect(mocks.creativeFeatureSet.upsert).toHaveBeenCalledOnce();
  });

  it("enforces sample maturity floors", () => {
    expect(creativePatternMaturity(4)).toBe("INSUFFICIENT_DATA");
    expect(creativePatternMaturity(5)).toBe("EMERGING_PATTERN");
    expect(creativePatternMaturity(14)).toBe("EMERGING_PATTERN");
    expect(creativePatternMaturity(15)).toBe("SUPPORTED_PATTERN");
    expect(creativePatternMaturity(39)).toBe("SUPPORTED_PATTERN");
    expect(creativePatternMaturity(40)).toBe("STRONG_PATTERN");
  });

  it("uses only supplied semantic fields and rejects views-only best claims", () => {
    const features = deriveCreativeFeatures({
      organisationId: "org_1",
      contentPieceId: "content_1",
      text: "Please subscribe",
      platform: "linkedin",
      format: "text",
      scheduledAt: "2026-08-24T09:00:00.000Z",
    });
    expect(features).toMatchObject({
      lengthChars: 16,
      ctaPresent: true,
      postingWindow: "MORNING",
      hookType: null,
      angle: null,
      tone: null,
    });
    expect(normalisePatternMetrics({ views: 1_000 })).toMatchObject({
      optimisationBasis: "INSUFFICIENT_QUALIFIED_DATA",
      bestFormatEligible: false,
    });
  });
});

describe("Phase 20F process twin", () => {
  it("uses atomic increments for daily rollups", async () => {
    mocks.processTransitionStat.upsert.mockResolvedValue({ id: "stat_1" });
    await applyProcessEvent({
      organisationId: "org_1",
      processKey: "lead_funnel",
      fromStage: "NEW",
      toStage: "QUALIFIED",
      durationMs: 2_500,
      humanIntervention: true,
      windowStart: new Date("2026-08-24T19:30:00.000Z"),
    });
    expect(mocks.processTransitionStat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          transitionCount: { increment: 1 },
          totalDurationMs: { increment: 2_500n },
          humanInterventionCount: { increment: 1 },
        }),
      }),
    );
    const call = mocks.processTransitionStat.upsert.mock.calls[0]![0];
    expect(
      call.where.organisationId_processKey_fromStage_toStage_windowStart.windowStart,
    ).toEqual(new Date("2026-08-24T00:00:00.000Z"));
  });

  it("creates a review candidate without enabling an automation rule", async () => {
    mocks.processTransitionStat.findMany.mockResolvedValue([
      {
        id: "stat_1",
        processKey: "lead_funnel",
        fromStage: "NEW",
        toStage: "QUALIFIED",
        transitionCount: 25,
        totalDurationMs: 2_500_000n,
      },
    ]);
    mocks.automationOpportunity.findFirst.mockResolvedValue(null);
    mocks.automationOpportunity.create.mockImplementation(
      async (args: { data: unknown }) => args.data,
    );

    const candidates = await detectAutomationOpportunities({
      organisationId: "org_1",
      processKey: "lead_funnel",
      since: new Date("2026-08-01T00:00:00.000Z"),
      volumeThreshold: 20,
      highDelayMs: 60_000,
    });
    expect(candidates).toHaveLength(1);
    expect(mocks.automationOpportunity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "DETECTED",
        metadata: expect.objectContaining({
          recommendationOnly: true,
          automationRuleEnabled: false,
        }),
      }),
    });
    expect(JSON.stringify(candidates)).not.toContain('"enabled":true');
  });

  it("does not invent percentile statistics from counter totals", async () => {
    mocks.processTransitionStat.findMany.mockResolvedValue([
      {
        id: "stat_1",
        processKey: "approvals",
        fromStage: "PENDING",
        toStage: "APPROVED",
        transitionCount: 10,
        totalDurationMs: 10_000n,
        metadata: {},
      },
    ]);
    mocks.processTransitionStat.update.mockResolvedValue({ id: "stat_1" });

    await reconcileProcessWindow(
      "org_1",
      "approvals",
      new Date("2026-08-01T00:00:00.000Z"),
    );
    expect(mocks.processTransitionStat.update).toHaveBeenCalledWith({
      where: { id: "stat_1" },
      data: expect.objectContaining({
        p50DurationMs: null,
        p90DurationMs: null,
        metadata: expect.objectContaining({
          averageDurationMs: 1_000,
          percentileMethod: "unavailable_without_histogram",
        }),
      }),
    });
  });
});
