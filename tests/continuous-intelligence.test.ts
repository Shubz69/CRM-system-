/**
 * Phase 16 — Continuous intelligence: collection, lifecycle, normalisation, quality bridge.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { TrendLifecycleState } from "@prisma/client";
import {
  appendMetricHistory,
  assessTrendQualityBridge,
  buildBaselineFromViews,
  deriveLifecycleFromFeatures,
  deriveLifecycleFromHistory,
  lifecycleStateToLabel,
  normalisePerformance,
  recordContinuousCollectionRun,
  runContinuousCollectionPass,
} from "@/services/continuous-intelligence";
import { inferLifecycleState } from "@/services/trend-intelligence";
import {
  createTestOrganisation,
  destroyTestOrganisation,
  type TestOrganisationFixture,
} from "./helpers/org-fixtures";
import { prisma } from "@/lib/db";

describe("trend lifecycle (deterministic history)", () => {
  it("defaults to EMERGING with empty history", () => {
    const d = deriveLifecycleFromHistory([]);
    expect(d.state).toBe(TrendLifecycleState.EMERGING);
    expect(d.label).toBe("EMERGING");
    expect(d.sampleSize).toBe(0);
  });

  it("maps product labels to Prisma enums", () => {
    expect(lifecycleStateToLabel(TrendLifecycleState.BREAKOUT)).toBe("BREAKING_OUT");
    expect(lifecycleStateToLabel(TrendLifecycleState.MAINSTREAM)).toBe("MATURE");
    expect(lifecycleStateToLabel(TrendLifecycleState.SATURATED)).toBe("SATURATING");
  });

  it("derives BREAKOUT / DECLINING from observables only", () => {
    expect(
      deriveLifecycleFromFeatures({
        velocity: 1.5,
        acceleration: 0.5,
        mentionCount: 15,
        crossPlatformCount: 3,
      }).state,
    ).toBe(TrendLifecycleState.BREAKOUT);

    expect(
      deriveLifecycleFromFeatures({
        velocity: 0.1,
        acceleration: -0.5,
        mentionCount: 5,
        crossPlatformCount: 1,
      }).state,
    ).toBe(TrendLifecycleState.DECLINING);
  });

  it("uses series slope for DECLINING when history is rich", () => {
    const points = [
      { at: 1, velocity: 1.2, acceleration: 0.2, mentionCount: 10, crossPlatformCount: 2 },
      { at: 2, velocity: 1.0, acceleration: 0, mentionCount: 12, crossPlatformCount: 2 },
      { at: 3, velocity: 0.5, acceleration: -0.2, mentionCount: 14, crossPlatformCount: 2 },
      { at: 4, velocity: 0.2, acceleration: -0.3, mentionCount: 15, crossPlatformCount: 2 },
    ];
    const d = deriveLifecycleFromHistory(points);
    expect(d.state).toBe(TrendLifecycleState.DECLINING);
    expect(d.observables.velocityDelta).not.toBeNull();
  });

  it("trend-intelligence inferLifecycleState delegates to the same rules", () => {
    expect(
      inferLifecycleState({
        velocity: 0.1,
        acceleration: 0,
        mentionCount: 1,
        crossPlatformCount: 1,
      }),
    ).toBe(TrendLifecycleState.EMERGING);
  });
});

describe("normalisation (baselines + age + audience)", () => {
  it("refuses composite when only raw views exist", () => {
    const r = normalisePerformance({ views: 50_000 });
    expect(r.sufficientForRelativeJudgement).toBe(false);
    expect(r.compositeIndex).toBeNull();
    expect(r.gaps).toContain("audience_size_missing");
    expect(r.caution).toMatch(/raw views alone/i);
  });

  it("produces relative index when creator baseline + age exist", () => {
    const publishedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const creatorBaseline = buildBaselineFromViews([1_000, 2_000, 3_000]);
    const r = normalisePerformance({
      views: 6_000,
      likes: 100,
      comments: 20,
      shares: 10,
      publishedAt,
      audienceSize: 10_000,
      creatorBaseline,
    });
    expect(r.ageAdjustedViewsPerDay).toBeGreaterThan(0);
    expect(r.audienceAdjustedRate).toBeGreaterThan(0);
    expect(r.relativeToCreator).not.toBeNull();
    expect(r.compositeIndex).not.toBeNull();
    expect(r.sufficientForRelativeJudgement).toBe(true);
  });

  it("buildBaselineFromViews never invents medians from empty cohorts", () => {
    expect(buildBaselineFromViews([])).toEqual({ medianViews: null, sampleSize: 0 });
  });
});

describe("quality bridge honesty", () => {
  it("uses Track 0 dimensions when wired — never invents calibrated percentages", async () => {
    const q = await assessTrendQualityBridge({
      organisationId: "org-test",
      subjectKind: "TrendCluster",
      subjectId: "t1",
      sampleSize: 5,
      sourceCount: 2,
      lastObservedAt: new Date(),
    });
    expect(q.available).toBe(true);
    expect(q.stub).toBe(false);
    expect(typeof q.dimensions.sourceQuality).toBe("number");
    expect(typeof q.dimensions.freshness).toBe("number");
    expect(typeof q.dimensions.sampleSize).toBe("number");
    expect(q.dimensions.sourceQuality!).toBeGreaterThanOrEqual(0);
    expect(q.dimensions.sourceQuality!).toBeLessThanOrEqual(1);
    expect(q.note).not.toMatch(/87%|calibrated probability/i);
  });
});

describe("collection append-only (DB)", () => {
  let org: TestOrganisationFixture;

  beforeAll(async () => {
    org = await createTestOrganisation("ci-collect");
  }, 60_000);

  afterAll(async () => {
    await destroyTestOrganisation(org);
  }, 60_000);

  it("records ContinuousCollectionRun and appends SocialMetricSnapshot history", async () => {
    const content = await prisma.socialContent.create({
      data: {
        organisationId: org.organisationId,
        platform: "youtube",
        url: `https://youtube.com/watch?v=ci-${Date.now()}`,
        format: "video",
        publishedAt: new Date(Date.now() - 86400000),
      },
    });

    const first = await appendMetricHistory({
      organisationId: org.organisationId,
      observations: [
        {
          socialContentId: content.id,
          views: 100,
          likes: 5,
          // comments/shares/score intentionally omitted → missingMetrics
        },
      ],
    });
    expect(first.appended).toBe(1);
    expect(first.missingMetricNotes[0]?.missingMetrics).toEqual(
      expect.arrayContaining(["comments", "shares", "score"]),
    );

    const second = await runContinuousCollectionPass({
      organisationId: org.organisationId,
      kind: "social_metrics",
      providerKey: "youtube",
      observations: [
        {
          socialContentId: content.id,
          views: 250,
          likes: 12,
          comments: 3,
        },
      ],
    });
    expect(second.appended).toBe(1);
    expect(second.run.itemsCollected).toBe(1);
    expect(second.run.status).toMatch(/COMPLETED/);

    const snaps = await prisma.socialMetricSnapshot.findMany({
      where: { organisationId: org.organisationId, socialContentId: content.id },
      orderBy: { capturedAt: "asc" },
    });
    expect(snaps.length).toBe(2);
    expect(snaps[0]!.views).toBe(100);
    expect(snaps[1]!.views).toBe(250);

    const run = await recordContinuousCollectionRun({
      organisationId: org.organisationId,
      kind: "heartbeat",
      itemsCollected: 0,
      metadata: { note: "empty pass" },
    });
    expect(run.id).toBeTruthy();
  });
});
