/**
 * Phase 5 — Trend features, lifecycle, forecasts with uncertainty, backtest harness.
 * Never invent hit rates: backtest metrics only when real TrendForecastOutcome rows exist.
 * Phase 16: lifecycle derivation delegated to continuous-intelligence/trend-lifecycle
 * (history-aware, deterministic — no LLM state assignment).
 */

import {
  AlgorithmEvidenceKind,
  Prisma,
  TrendForecastHorizon,
  TrendLifecycleState,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  deriveLifecycleFromFeatures,
  deriveLifecycleFromHistory,
  type LifecycleHistoryPoint,
} from "@/services/continuous-intelligence/trend-lifecycle";

const WINDOW_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const HORIZON_MS: Record<TrendForecastHorizon, number> = {
  H24: 24 * 60 * 60 * 1000,
  D3: 3 * 24 * 60 * 60 * 1000,
  D7: 7 * 24 * 60 * 60 * 1000,
  D30: 30 * 24 * 60 * 60 * 1000,
};

export function normalizeTrendKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

/**
 * Single-observation lifecycle helper — delegates to continuous-intelligence rules.
 * Prefer deriveLifecycleFromHistory when TrendFeatureSnapshot series exist.
 */
export function inferLifecycleState(input: {
  velocity: number;
  acceleration: number;
  mentionCount: number;
  crossPlatformCount: number;
  priorState?: TrendLifecycleState | null;
}): TrendLifecycleState {
  return deriveLifecycleFromFeatures(input).state;
}

export function computeForecastProbability(input: {
  state: TrendLifecycleState;
  velocity: number;
  acceleration: number;
  crossPlatformCount: number;
}): { probability: number; uncertainty: number; drivers: string[]; counterSignals: string[] } {
  const drivers: string[] = [];
  const counterSignals: string[] = [];
  let p = 0.45;
  let u = 0.25;

  if (input.state === TrendLifecycleState.ACCELERATING || input.state === TrendLifecycleState.BREAKOUT) {
    p += 0.2;
    drivers.push(`Lifecycle is ${input.state.toLowerCase()}`);
  }
  if (input.state === TrendLifecycleState.DECLINING || input.state === TrendLifecycleState.SATURATED) {
    p -= 0.2;
    counterSignals.push(`Lifecycle is ${input.state.toLowerCase()}`);
  }
  if (input.velocity >= 1) {
    p += 0.1;
    drivers.push("High recent velocity");
  } else if (input.velocity < 0.2) {
    p -= 0.1;
    counterSignals.push("Low velocity");
  }
  if (input.acceleration > 0.2) {
    p += 0.08;
    drivers.push("Positive acceleration");
  } else if (input.acceleration < -0.2) {
    p -= 0.08;
    counterSignals.push("Negative acceleration");
  }
  if (input.crossPlatformCount >= 2) {
    p += 0.07;
    drivers.push(`Seen on ${input.crossPlatformCount} platforms`);
  } else {
    u += 0.05;
    counterSignals.push("Single-platform signal");
  }

  // Sparse data → wider uncertainty
  if (input.crossPlatformCount < 2 && input.velocity < 0.5) {
    u = Math.min(0.45, u + 0.1);
  }

  return {
    probability: Math.min(0.92, Math.max(0.08, p)),
    uncertainty: Math.min(0.45, Math.max(0.08, u)),
    drivers,
    counterSignals,
  };
}

/**
 * Refresh trend clusters from recent TrendSignal + SocialContent topics for an org/job.
 */
export async function refreshTrendsForOrganisation(input: {
  organisationId: string;
  researchJobId?: string;
}): Promise<{ clustersUpserted: number; forecastsCreated: number }> {
  const now = new Date();
  const since7d = new Date(now.getTime() - WINDOW_MS["7d"]!);

  const signals = await prisma.trendSignal.findMany({
    where: {
      organisationId: input.organisationId,
      ...(input.researchJobId ? { researchJobId: input.researchJobId } : { createdAt: { gte: since7d } }),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const contents = await prisma.socialContent.findMany({
    where: {
      organisationId: input.organisationId,
      lastSeenAt: { gte: since7d },
    },
    include: {
      metrics: {
        where: { capturedAt: { gte: since7d } },
        orderBy: { capturedAt: "desc" },
        take: 5,
      },
    },
    take: 300,
  });

  type Agg = {
    label: string;
    kind: string;
    platforms: Set<string>;
    urls: Set<string>;
    mentionCount: number;
    engagementScore: number;
    timestamps: number[];
  };

  const map = new Map<string, Agg>();

  function bump(label: string, kind: string, platform?: string | null, url?: string | null, eng = 0, at?: Date) {
    const key = normalizeTrendKey(label);
    if (!key) return;
    let row = map.get(key);
    if (!row) {
      row = {
        label: label.trim().slice(0, 200),
        kind,
        platforms: new Set(),
        urls: new Set(),
        mentionCount: 0,
        engagementScore: 0,
        timestamps: [],
      };
      map.set(key, row);
    }
    row.mentionCount += 1;
    row.engagementScore += eng;
    if (platform) row.platforms.add(platform);
    if (url) row.urls.add(url);
    if (at) row.timestamps.push(at.getTime());
  }

  for (const s of signals) {
    bump(s.label, s.signalType || "theme", null, s.evidenceUrls[0] ?? null, s.frequency, s.createdAt);
    for (const u of s.evidenceUrls.slice(0, 5)) rowAddUrl(map, normalizeTrendKey(s.label), u);
  }

  for (const c of contents) {
    const eng = c.metrics[0]?.score ?? c.metrics[0]?.views ?? 0;
    for (const topic of c.topics) {
      bump(topic, "topic", c.platform, c.url, Number(eng) || 0, c.lastSeenAt);
    }
    if (c.format) {
      bump(`${c.platform}:${c.format}`, "format", c.platform, c.url, Number(eng) || 0, c.lastSeenAt);
    }
  }

  let clustersUpserted = 0;
  let forecastsCreated = 0;

  for (const [key, agg] of map) {
    const timestamps = agg.timestamps.sort((a, b) => a - b);
    const mid = now.getTime() - WINDOW_MS["3d"]!;
    const recent = timestamps.filter((t) => t >= mid).length;
    const older = Math.max(1, timestamps.filter((t) => t < mid).length);
    const velocity = recent / Math.max(1, older);
    const priorWindow = timestamps.filter(
      (t) => t < mid && t >= now.getTime() - WINDOW_MS["7d"]!,
    ).length;
    const acceleration = (recent - priorWindow) / Math.max(1, priorWindow);

    const existing = await prisma.trendCluster.findUnique({
      where: {
        organisationId_key: { organisationId: input.organisationId, key },
      },
    });

    const priorSnaps = existing
      ? await prisma.trendFeatureSnapshot.findMany({
          where: {
            organisationId: input.organisationId,
            trendClusterId: existing.id,
          },
          orderBy: { capturedAt: "asc" },
          take: 40,
        })
      : [];

    const pendingPoint: LifecycleHistoryPoint = {
      at: now,
      velocity,
      acceleration,
      mentionCount: agg.mentionCount,
      crossPlatformCount: agg.platforms.size,
      engagementScore: agg.engagementScore,
    };
    const historyPoints: LifecycleHistoryPoint[] = [
      ...priorSnaps.map((s) => ({
        at: s.capturedAt,
        velocity: s.velocity,
        acceleration: s.acceleration,
        mentionCount: s.mentionCount,
        crossPlatformCount: s.crossPlatformCount,
        engagementScore: s.engagementScore,
      })),
      pendingPoint,
    ];
    const lifecycle = deriveLifecycleFromHistory(historyPoints, existing?.state);
    const state = lifecycle.state;

    const features = {
      velocity,
      acceleration,
      mentionCount: agg.mentionCount,
      crossPlatformCount: agg.platforms.size,
      engagementScore: agg.engagementScore,
      window: "7d",
      lifecycleLabel: lifecycle.label,
      lifecycleSampleSize: lifecycle.sampleSize,
      lifecycleRationale: lifecycle.rationale,
    };

    const cluster = await prisma.trendCluster.upsert({
      where: {
        organisationId_key: { organisationId: input.organisationId, key },
      },
      create: {
        organisationId: input.organisationId,
        key,
        label: agg.label,
        kind: agg.kind,
        state,
        platforms: [...agg.platforms],
        evidenceUrls: [...agg.urls].slice(0, 20),
        features: features as Prisma.InputJsonValue,
        firstSeenAt: timestamps[0] ? new Date(timestamps[0]) : now,
        lastSeenAt: now,
      },
      update: {
        label: agg.label,
        kind: agg.kind,
        state,
        platforms: [...agg.platforms],
        evidenceUrls: [...agg.urls].slice(0, 20),
        features: features as Prisma.InputJsonValue,
        lastSeenAt: now,
      },
    });
    clustersUpserted += 1;

    const snap = await prisma.trendFeatureSnapshot.create({
      data: {
        organisationId: input.organisationId,
        trendClusterId: cluster.id,
        window: "7d",
        mentionCount: agg.mentionCount,
        contentCount: agg.urls.size,
        velocity,
        acceleration,
        crossPlatformCount: agg.platforms.size,
        engagementScore: agg.engagementScore,
        features: features as Prisma.InputJsonValue,
      },
    });

    // Forecast only when we have enough signal — still uncertain by design.
    if (agg.mentionCount >= 2) {
      const fc = computeForecastProbability({
        state,
        velocity,
        acceleration,
        crossPlatformCount: agg.platforms.size,
      });
      const horizon = TrendForecastHorizon.D7;
      await prisma.trendForecast.create({
        data: {
          organisationId: input.organisationId,
          trendClusterId: cluster.id,
          horizon,
          probability: fc.probability,
          uncertainty: fc.uncertainty,
          drivers: fc.drivers,
          counterSignals: fc.counterSignals,
          featureSnapshotId: snap.id,
          confidenceLabel:
            fc.uncertainty <= 0.15 ? "high" : fc.uncertainty <= 0.28 ? "medium" : "low",
          resolveAfter: new Date(now.getTime() + HORIZON_MS[horizon]),
        },
      });
      forecastsCreated += 1;
    }
  }

  return { clustersUpserted, forecastsCreated };
}

function rowAddUrl(map: Map<string, { urls: Set<string> }>, key: string, url: string) {
  const row = map.get(key);
  if (row && url) row.urls.add(url);
}

export async function recordAlgorithmChange(input: {
  organisationId: string;
  platform: string;
  surface?: string | null;
  changeType: string;
  title: string;
  summary?: string | null;
  evidenceKind: AlgorithmEvidenceKind;
  confidence?: number | null;
  sourceUrl?: string | null;
  detectedAt?: Date;
  effectiveAt?: Date | null;
  affectedFormats?: string[];
  expectedImpact?: string | null;
  recommendedExperiment?: string | null;
}): Promise<string> {
  // Official requires a source URL — otherwise force OBSERVATIONAL/UNKNOWN.
  let kind = input.evidenceKind;
  if (kind === AlgorithmEvidenceKind.OFFICIAL && !input.sourceUrl?.trim()) {
    kind = AlgorithmEvidenceKind.UNKNOWN;
  }

  const row = await prisma.algorithmChange.create({
    data: {
      organisationId: input.organisationId,
      platform: input.platform,
      surface: input.surface ?? null,
      changeType: input.changeType,
      title: input.title,
      summary: input.summary ?? null,
      evidenceKind: kind,
      confidence: input.confidence ?? null,
      sourceUrl: input.sourceUrl ?? null,
      detectedAt: input.detectedAt ?? new Date(),
      effectiveAt: input.effectiveAt ?? null,
      affectedFormats: input.affectedFormats ?? [],
      expectedImpact: input.expectedImpact ?? null,
      recommendedExperiment: input.recommendedExperiment ?? null,
    },
  });
  return row.id;
}

/**
 * Evaluate due forecasts against current cluster state.
 * Returns how many outcomes were written (0 if nothing resolvable).
 */
export async function evaluateDueForecasts(input: {
  organisationId: string;
  asOf?: Date;
}): Promise<number> {
  const asOf = input.asOf ?? new Date();
  const due = await prisma.trendForecast.findMany({
    where: {
      organisationId: input.organisationId,
      resolveAfter: { lte: asOf },
      outcome: null,
    },
    include: { trendCluster: true },
    take: 100,
  });

  let written = 0;
  for (const f of due) {
    const state = f.trendCluster.state;
    const realizedPositive =
      state === TrendLifecycleState.ACCELERATING ||
      state === TrendLifecycleState.BREAKOUT ||
      state === TrendLifecycleState.MAINSTREAM ||
      state === TrendLifecycleState.RECURRING;
    await prisma.trendForecastOutcome.create({
      data: {
        organisationId: input.organisationId,
        trendForecastId: f.id,
        realizedPositive,
        realizedState: state,
        notes: `Auto-evaluated against cluster state ${state}`,
        evaluatedAt: asOf,
      },
    });
    written += 1;
  }
  return written;
}

export type BacktestSummary = {
  sampleSize: number;
  /** null when sampleSize === 0 — never invent a score. */
  brierScore: number | null;
  accuracy: number | null;
  message: string;
};

/**
 * Backtest metrics only when real outcomes exist.
 */
export async function getForecastBacktestSummary(input: {
  organisationId: string;
}): Promise<BacktestSummary> {
  const rows = await prisma.trendForecast.findMany({
    where: {
      organisationId: input.organisationId,
      outcome: { isNot: null },
    },
    include: { outcome: true },
    take: 500,
  });

  if (!rows.length) {
    return {
      sampleSize: 0,
      brierScore: null,
      accuracy: null,
      message: "No resolved forecasts yet — backtest metrics are hidden until real history exists.",
    };
  }

  let brierSum = 0;
  let correct = 0;
  for (const r of rows) {
    const y = r.outcome!.realizedPositive ? 1 : 0;
    brierSum += (r.probability - y) ** 2;
    const predictedPositive = r.probability >= 0.5;
    if (predictedPositive === r.outcome!.realizedPositive) correct += 1;
  }

  return {
    sampleSize: rows.length,
    brierScore: brierSum / rows.length,
    accuracy: correct / rows.length,
    message: `Based on ${rows.length} resolved forecast${rows.length === 1 ? "" : "s"}.`,
  };
}
