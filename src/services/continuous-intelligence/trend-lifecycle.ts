/**
 * Deterministic trend lifecycle from observable history only.
 * Maps product language → Prisma TrendLifecycleState:
 *   BREAKING_OUT → BREAKOUT, MATURE → MAINSTREAM, SATURATING → SATURATED
 * Never LLM-assigns lifecycle.
 */

import { Prisma, TrendLifecycleState } from "@prisma/client";
import { prisma } from "@/lib/db";

export type LifecycleHistoryPoint = {
  at: Date | number;
  velocity: number;
  acceleration: number;
  mentionCount: number;
  crossPlatformCount: number;
  engagementScore?: number;
};

export type LifecycleDerivation = {
  state: TrendLifecycleState;
  /** Product-facing alias of `state` (BREAKING_OUT / MATURE / SATURATING where applicable). */
  label:
    | "EMERGING"
    | "ACCELERATING"
    | "BREAKING_OUT"
    | "MATURE"
    | "SATURATING"
    | "DECLINING"
    | "RECURRING";
  rationale: string[];
  sampleSize: number;
  observables: {
    latestVelocity: number;
    latestAcceleration: number;
    velocityDelta: number | null;
    peakMentions: number;
    maxCrossPlatform: number;
  };
};

/** Prisma enum → product label (BREAKOUT→BREAKING_OUT etc.). */
export function lifecycleStateToLabel(
  state: TrendLifecycleState,
): LifecycleDerivation["label"] {
  switch (state) {
    case TrendLifecycleState.BREAKOUT:
      return "BREAKING_OUT";
    case TrendLifecycleState.MAINSTREAM:
      return "MATURE";
    case TrendLifecycleState.SATURATED:
      return "SATURATING";
    case TrendLifecycleState.EMERGING:
      return "EMERGING";
    case TrendLifecycleState.ACCELERATING:
      return "ACCELERATING";
    case TrendLifecycleState.DECLINING:
      return "DECLINING";
    case TrendLifecycleState.RECURRING:
      return "RECURRING";
    default:
      return "EMERGING";
  }
}

function sortPoints(points: LifecycleHistoryPoint[]): LifecycleHistoryPoint[] {
  return [...points].sort(
    (a, b) => (typeof a.at === "number" ? a.at : a.at.getTime()) - (typeof b.at === "number" ? b.at : b.at.getTime()),
  );
}

/**
 * Derive lifecycle solely from an ordered feature/time-series history.
 * Sparse history → EMERGING (honest under-confidence, not invention).
 */
export function deriveLifecycleFromHistory(
  points: LifecycleHistoryPoint[],
  priorState?: TrendLifecycleState | null,
): LifecycleDerivation {
  const rationale: string[] = [];
  const sorted = sortPoints(points);
  const sampleSize = sorted.length;

  if (sampleSize === 0) {
    return {
      state: TrendLifecycleState.EMERGING,
      label: "EMERGING",
      rationale: ["No observable history — default EMERGING"],
      sampleSize: 0,
      observables: {
        latestVelocity: 0,
        latestAcceleration: 0,
        velocityDelta: null,
        peakMentions: 0,
        maxCrossPlatform: 0,
      },
    };
  }

  const latest = sorted[sorted.length - 1]!;
  const peakMentions = Math.max(...sorted.map((p) => p.mentionCount));
  const maxCrossPlatform = Math.max(...sorted.map((p) => p.crossPlatformCount));

  let velocityDelta: number | null = null;
  if (sampleSize >= 2) {
    const prev = sorted[sorted.length - 2]!;
    velocityDelta = latest.velocity - prev.velocity;
    rationale.push(
      `Velocity delta (latest−prior)=${velocityDelta.toFixed(3)} over ${sampleSize} observations`,
    );
  } else {
    rationale.push("Single observation — lifecycle constrained to early/uncertain states");
  }

  // Mid-series slope: compare first half vs second half mean velocity when enough points.
  let seriesSlope: number | null = null;
  if (sampleSize >= 4) {
    const mid = Math.floor(sampleSize / 2);
    const early = sorted.slice(0, mid);
    const late = sorted.slice(mid);
    const mean = (arr: LifecycleHistoryPoint[]) =>
      arr.reduce((s, p) => s + p.velocity, 0) / Math.max(1, arr.length);
    seriesSlope = mean(late) - mean(early);
    rationale.push(`Series velocity slope (late−early mean)=${seriesSlope.toFixed(3)}`);
  }

  const { velocity, acceleration, mentionCount, crossPlatformCount } = latest;

  let state: TrendLifecycleState;

  if (
    priorState === TrendLifecycleState.DECLINING &&
    velocity > 0.5 &&
    acceleration > 0 &&
    (velocityDelta == null || velocityDelta > 0)
  ) {
    state = TrendLifecycleState.RECURRING;
    rationale.push("Prior DECLINING with recovering velocity/acceleration → RECURRING");
  } else if (
    (acceleration < -0.3 && velocity < 0.2) ||
    (seriesSlope != null && seriesSlope < -0.4 && velocity < 0.4)
  ) {
    state = TrendLifecycleState.DECLINING;
    rationale.push("Negative acceleration / declining series slope → DECLINING");
  } else if (mentionCount >= 20 && crossPlatformCount >= 3 && velocity < 0.5) {
    state = TrendLifecycleState.SATURATED;
    rationale.push("High mentions + multi-platform + low velocity → SATURATED (SATURATING)");
  } else if (
    mentionCount >= 12 &&
    crossPlatformCount >= 2 &&
    velocity >= 1 &&
    (acceleration > 0 || (velocityDelta != null && velocityDelta > 0))
  ) {
    state = TrendLifecycleState.BREAKOUT;
    rationale.push("High velocity + multi-platform growth → BREAKOUT (BREAKING_OUT)");
  } else if (mentionCount >= 8 && velocity >= 0.5 && (acceleration >= 0 || (velocityDelta != null && velocityDelta > 0))) {
    state = TrendLifecycleState.ACCELERATING;
    rationale.push("Rising velocity with solid mentions → ACCELERATING");
  } else if (mentionCount >= 15 && velocity >= 0.2 && velocity < 0.8) {
    state = TrendLifecycleState.MAINSTREAM;
    rationale.push("Stable mid velocity + broad mentions → MAINSTREAM (MATURE)");
  } else {
    state = TrendLifecycleState.EMERGING;
    rationale.push("Does not meet later-stage thresholds → EMERGING");
  }

  return {
    state,
    label: lifecycleStateToLabel(state),
    rationale,
    sampleSize,
    observables: {
      latestVelocity: velocity,
      latestAcceleration: acceleration,
      velocityDelta,
      peakMentions,
      maxCrossPlatform,
    },
  };
}

/**
 * Single-feature adapter (compatible with legacy trend-intelligence callers).
 * Still deterministic — wraps a one-point history.
 */
export function deriveLifecycleFromFeatures(input: {
  velocity: number;
  acceleration: number;
  mentionCount: number;
  crossPlatformCount: number;
  priorState?: TrendLifecycleState | null;
  engagementScore?: number;
  at?: Date;
}): LifecycleDerivation {
  return deriveLifecycleFromHistory(
    [
      {
        at: input.at ?? Date.now(),
        velocity: input.velocity,
        acceleration: input.acceleration,
        mentionCount: input.mentionCount,
        crossPlatformCount: input.crossPlatformCount,
        engagementScore: input.engagementScore,
      },
    ],
    input.priorState,
  );
}

/**
 * Load TrendFeatureSnapshot history for a cluster and persist derived state on TrendCluster.
 */
export async function applyLifecycleFromClusterHistory(input: {
  organisationId: string;
  trendClusterId: string;
  /** Optional latest point not yet snapshotted. */
  pendingPoint?: LifecycleHistoryPoint;
}): Promise<LifecycleDerivation> {
  const cluster = await prisma.trendCluster.findFirst({
    where: { id: input.trendClusterId, organisationId: input.organisationId },
  });
  if (!cluster) {
    return deriveLifecycleFromHistory(input.pendingPoint ? [input.pendingPoint] : []);
  }

  const snaps = await prisma.trendFeatureSnapshot.findMany({
    where: {
      organisationId: input.organisationId,
      trendClusterId: input.trendClusterId,
    },
    orderBy: { capturedAt: "asc" },
    take: 40,
  });

  const points: LifecycleHistoryPoint[] = snaps.map((s) => ({
    at: s.capturedAt,
    velocity: s.velocity,
    acceleration: s.acceleration,
    mentionCount: s.mentionCount,
    crossPlatformCount: s.crossPlatformCount,
    engagementScore: s.engagementScore,
  }));
  if (input.pendingPoint) points.push(input.pendingPoint);

  const derivation = deriveLifecycleFromHistory(points, cluster.state);

  await prisma.trendCluster.update({
    where: { id: cluster.id },
    data: {
      state: derivation.state,
      features: {
        ...((typeof cluster.features === "object" && cluster.features !== null
          ? cluster.features
          : {}) as Record<string, unknown>),
        lifecycle: {
          label: derivation.label,
          rationale: derivation.rationale,
          sampleSize: derivation.sampleSize,
          observables: derivation.observables,
          derivedAt: new Date().toISOString(),
          source: "continuous-intelligence/trend-lifecycle",
        },
      } as Prisma.InputJsonValue,
    },
  });

  return derivation;
}
