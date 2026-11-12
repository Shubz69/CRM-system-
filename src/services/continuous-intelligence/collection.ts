/**
 * Continuous collection runs + append-only SocialMetricSnapshot history.
 * Never overwrite prior totals; missing platform metrics stay explicit nulls.
 *
 * Write-load rules:
 * - A snapshot is appended only when its metrics differ from the latest snapshot
 *   for that content. Identical re-observations are skipped (never overwritten).
 * - SocialContent.lastSeenAt only moves forward, at most once per
 *   SOCIAL_CONTENT_LAST_SEEN_THROTTLE_MS (default 15 min) per content.
 * - The scheduled sweep only snapshots PostPerformance rows that are newer than the
 *   latest snapshot, and logs a no-op ContinuousCollectionRun at most once per
 *   heartbeat window per org (it used to re-copy the latest snapshot and write a
 *   run row for every org on every sweep).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sweepEligibleOrganisationWhere } from "@/services/sweep-eligibility";

export type MetricObservation = {
  socialContentId: string;
  capturedAt?: Date;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  score?: number | null;
  raw?: Record<string, unknown>;
  /**
   * Metrics the provider did not return (honest gaps).
   * When omitted, inferred from null numeric fields among the standard set.
   */
  missingMetrics?: string[];
};

export type CollectionRunInput = {
  organisationId: string;
  kind: string;
  providerKey?: string | null;
  status?: string;
  observedAt?: Date;
  errorSummary?: string | null;
  metadata?: Record<string, unknown>;
};

const STANDARD_METRICS = ["views", "likes", "comments", "shares", "score"] as const;

const LAST_SEEN_THROTTLE_MS = Number(
  process.env.SOCIAL_CONTENT_LAST_SEEN_THROTTLE_MS || 15 * 60_000,
);
const EMPTY_SWEEP_RUN_HEARTBEAT_MS = Number(
  process.env.CONTINUOUS_INTEL_EMPTY_RUN_HEARTBEAT_MS || 24 * 60 * 60_000,
);

type MetricValues = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  score: number | null;
};

type LatestSnapshotRow = MetricValues & { socialContentId: string; capturedAt: Date };

type LatestPerformanceRow = Omit<MetricValues, "score"> & {
  socialContentId: string;
  capturedAt: Date;
};

function inferMissing(obs: MetricObservation): string[] {
  if (obs.missingMetrics?.length) return [...obs.missingMetrics];
  const missing: string[] = [];
  for (const key of STANDARD_METRICS) {
    if (obs[key] == null) missing.push(key);
  }
  return missing;
}

function hasAnyMetric(obs: MetricObservation): boolean {
  return (
    obs.views != null ||
    obs.likes != null ||
    obs.comments != null ||
    obs.shares != null ||
    obs.score != null
  );
}

function sameEngagement(
  a: Omit<MetricValues, "score">,
  b: Omit<MetricValues, "score">,
): boolean {
  return (
    a.views === b.views &&
    a.likes === b.likes &&
    a.comments === b.comments &&
    a.shares === b.shares
  );
}

function sameMetrics(a: MetricValues, b: MetricValues): boolean {
  return sameEngagement(a, b) && a.score === b.score;
}

/**
 * Latest SocialMetricSnapshot per content — one indexed LATERAL probe per id
 * (was one findFirst round trip per content).
 */
async function latestSnapshotsFor(
  organisationId: string,
  contentIds: string[],
): Promise<Map<string, LatestSnapshotRow>> {
  if (contentIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<LatestSnapshotRow[]>`
    SELECT s."socialContentId", s."capturedAt", s."views", s."likes", s."comments", s."shares", s."score"
    FROM unnest(${contentIds}::text[]) AS c(id)
    CROSS JOIN LATERAL (
      SELECT "socialContentId", "capturedAt", "views", "likes", "comments", "shares", "score"
      FROM "SocialMetricSnapshot"
      WHERE "organisationId" = ${organisationId} AND "socialContentId" = c.id
      ORDER BY "capturedAt" DESC
      LIMIT 1
    ) s
  `;
  return new Map(rows.map((r) => [r.socialContentId, r]));
}

/** Latest PostPerformance per content (same LATERAL pattern). */
async function latestPerformanceFor(
  organisationId: string,
  contentIds: string[],
): Promise<Map<string, LatestPerformanceRow>> {
  if (contentIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<LatestPerformanceRow[]>`
    SELECT p."socialContentId", p."capturedAt", p."views", p."likes", p."comments", p."shares"
    FROM unnest(${contentIds}::text[]) AS c(id)
    CROSS JOIN LATERAL (
      SELECT "socialContentId", "capturedAt", "views", "likes", "comments", "shares"
      FROM "PostPerformance"
      WHERE "organisationId" = ${organisationId} AND "socialContentId" = c.id
      ORDER BY "capturedAt" DESC
      LIMIT 1
    ) p
  `;
  return new Map(rows.map((r) => [r.socialContentId, r]));
}

/**
 * Persist a ContinuousCollectionRun row (scheduled ingest bookkeeping).
 */
export async function recordContinuousCollectionRun(
  input: CollectionRunInput & { itemsCollected?: number },
) {
  return prisma.continuousCollectionRun.create({
    data: {
      organisationId: input.organisationId,
      kind: input.kind,
      providerKey: input.providerKey ?? null,
      status: input.status ?? "COMPLETED",
      observedAt: input.observedAt ?? new Date(),
      itemsCollected: input.itemsCollected ?? 0,
      errorSummary: input.errorSummary ?? null,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/**
 * Append metric snapshots for known SocialContent rows.
 * Inserts new rows only — never updates an existing SocialMetricSnapshot. An
 * observation identical to the latest snapshot for that content is skipped
 * (counted in `skippedUnchanged`) instead of being stored again.
 */
export async function appendMetricHistory(input: {
  organisationId: string;
  observations: MetricObservation[];
}): Promise<{
  appended: number;
  skippedEmpty: number;
  skippedUnknownContent: number;
  skippedUnchanged: number;
  missingMetricNotes: Array<{ socialContentId: string; missingMetrics: string[] }>;
  snapshotIds: string[];
}> {
  let skippedEmpty = 0;
  let skippedUnknownContent = 0;
  let skippedUnchanged = 0;
  const missingMetricNotes: Array<{ socialContentId: string; missingMetrics: string[] }> = [];

  const ids = [...new Set(input.observations.map((o) => o.socialContentId))];
  const contents = ids.length
    ? await prisma.socialContent.findMany({
        where: { organisationId: input.organisationId, id: { in: ids } },
        select: { id: true, lastSeenAt: true },
      })
    : [];
  const lastSeenById = new Map(contents.map((c) => [c.id, c.lastSeenAt]));
  const latest = await latestSnapshotsFor(input.organisationId, [...lastSeenById.keys()]);

  const rows: Prisma.SocialMetricSnapshotCreateManyInput[] = [];
  /** capturedAt (ms) → content ids whose lastSeenAt should move forward. */
  const lastSeenBumps = new Map<number, string[]>();

  for (const obs of input.observations) {
    const lastSeenAt = lastSeenById.get(obs.socialContentId);
    if (lastSeenAt === undefined) {
      skippedUnknownContent += 1;
      continue;
    }

    const missingMetrics = inferMissing(obs);
    if (missingMetrics.length) {
      missingMetricNotes.push({
        socialContentId: obs.socialContentId,
        missingMetrics,
      });
    }

    if (!hasAnyMetric(obs)) {
      skippedEmpty += 1;
      continue;
    }

    const capturedAt = obs.capturedAt ?? new Date();
    const values: MetricValues = {
      views: obs.views ?? null,
      likes: obs.likes ?? null,
      comments: obs.comments ?? null,
      shares: obs.shares ?? null,
      score: obs.score ?? null,
    };

    if (capturedAt.getTime() - lastSeenAt.getTime() >= LAST_SEEN_THROTTLE_MS) {
      const list = lastSeenBumps.get(capturedAt.getTime()) ?? [];
      list.push(obs.socialContentId);
      lastSeenBumps.set(capturedAt.getTime(), list);
      lastSeenById.set(obs.socialContentId, capturedAt);
    }

    const prev = latest.get(obs.socialContentId);
    if (prev && sameMetrics(prev, values)) {
      skippedUnchanged += 1;
      continue;
    }

    rows.push({
      organisationId: input.organisationId,
      socialContentId: obs.socialContentId,
      capturedAt,
      ...values,
      raw: {
        ...(obs.raw ?? {}),
        missingMetrics,
        appendOnly: true,
      } as Prisma.InputJsonValue,
    });
    latest.set(obs.socialContentId, {
      socialContentId: obs.socialContentId,
      capturedAt,
      ...values,
    });
  }

  const created = rows.length
    ? await prisma.socialMetricSnapshot.createManyAndReturn({
        data: rows,
        select: { id: true },
      })
    : [];

  for (const [ms, contentIds] of lastSeenBumps) {
    const capturedAt = new Date(ms);
    await prisma.socialContent.updateMany({
      where: {
        organisationId: input.organisationId,
        id: { in: contentIds },
        lastSeenAt: { lt: capturedAt },
      },
      data: { lastSeenAt: capturedAt },
    });
  }

  return {
    appended: created.length,
    skippedEmpty,
    skippedUnknownContent,
    skippedUnchanged,
    missingMetricNotes,
    snapshotIds: created.map((s) => s.id),
  };
}

/**
 * Record a collection run and append metric history in one pass.
 * Status stays honest when some platform metrics were absent.
 */
export async function runContinuousCollectionPass(input: {
  organisationId: string;
  kind: string;
  providerKey?: string | null;
  observations: MetricObservation[];
  metadata?: Record<string, unknown>;
  errorSummary?: string | null;
}) {
  const appendResult = await appendMetricHistory({
    organisationId: input.organisationId,
    observations: input.observations,
  });

  const anyMissing = appendResult.missingMetricNotes.some((n) => n.missingMetrics.length > 0);
  const status =
    input.errorSummary
      ? "PARTIAL"
      : appendResult.skippedUnknownContent > 0 || anyMissing
        ? "COMPLETED_WITH_GAPS"
        : "COMPLETED";

  const run = await recordContinuousCollectionRun({
    organisationId: input.organisationId,
    kind: input.kind,
    providerKey: input.providerKey,
    status,
    itemsCollected: appendResult.appended,
    errorSummary: input.errorSummary ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      skippedEmpty: appendResult.skippedEmpty,
      skippedUnknownContent: appendResult.skippedUnknownContent,
      skippedUnchanged: appendResult.skippedUnchanged,
      missingMetricNotes: appendResult.missingMetricNotes.slice(0, 50),
      honesty:
        "Platform metrics that were not returned are recorded as null + listed in missingMetrics — never invented.",
    },
  });

  return { run, ...appendResult };
}

/** In-process: last time a no-op scheduled_sweep run row was written per org. */
const lastEmptySweepRunAt = new Map<string, number>();

function claimEmptySweepHeartbeat(organisationId: string, now: number): boolean {
  const last = lastEmptySweepRunAt.get(organisationId);
  if (last != null && now - last < EMPTY_SWEEP_RUN_HEARTBEAT_MS) return false;
  lastEmptySweepRunAt.set(organisationId, now);
  if (lastEmptySweepRunAt.size > 5_000) {
    for (const [k, at] of lastEmptySweepRunAt) {
      if (now - at >= EMPTY_SWEEP_RUN_HEARTBEAT_MS) lastEmptySweepRunAt.delete(k);
    }
  }
  return true;
}

/**
 * Postgres sweep: for each org, append snapshots from PostPerformance rows that are
 * newer than (and different from) the latest SocialMetricSnapshot for that content.
 * Never invents metrics — skips content with no observed engagement fields, and never
 * re-copies an existing snapshot. A no-op sweep is logged at most once per heartbeat
 * window per org.
 */
export async function sweepContinuousIntelligence(
  limitOrgs = 50,
  options?: { organisationIds?: string[] },
): Promise<{
  orgsProcessed: number;
  runsCreated: number;
  snapshotsAppended: number;
}> {
  const orgs = options?.organisationIds?.length
    ? await prisma.organisation.findMany({
        where: {
          id: { in: options.organisationIds },
          deletedAt: null,
          isPlatform: false,
        },
        select: { id: true },
      })
    : await prisma.organisation.findMany({
        where: sweepEligibleOrganisationWhere(),
        select: { id: true },
        take: Math.max(1, Math.min(limitOrgs, 200)),
        orderBy: { lastActivityAt: "desc" },
      });

  let runsCreated = 0;
  let snapshotsAppended = 0;

  for (const org of orgs) {
    try {
      const contents = await prisma.socialContent.findMany({
        where: { organisationId: org.id },
        select: { id: true, platform: true },
        take: 40,
        orderBy: { lastSeenAt: "desc" },
      });

      const contentIds = contents.map((c) => c.id);
      const [latestSnaps, latestPerfs] = contentIds.length
        ? await Promise.all([
            latestSnapshotsFor(org.id, contentIds),
            latestPerformanceFor(org.id, contentIds),
          ])
        : [new Map<string, LatestSnapshotRow>(), new Map<string, LatestPerformanceRow>()];

      const observations: MetricObservation[] = [];
      const providerKeys = new Set<string>();

      for (const content of contents) {
        providerKeys.add(content.platform);

        const perf = latestPerfs.get(content.id);
        if (!perf) continue;
        const snap = latestSnaps.get(content.id);
        // Nothing observed since the last snapshot — re-copying it adds no information.
        if (snap && perf.capturedAt.getTime() <= snap.capturedAt.getTime()) continue;

        const engagement = {
          views: perf.views ?? null,
          likes: perf.likes ?? null,
          comments: perf.comments ?? null,
          shares: perf.shares ?? null,
        };
        if (
          engagement.views == null &&
          engagement.likes == null &&
          engagement.comments == null &&
          engagement.shares == null
        ) {
          continue;
        }
        if (snap && sameEngagement(snap, engagement)) continue;

        observations.push({
          socialContentId: content.id,
          capturedAt: new Date(),
          ...engagement,
          score: null,
          raw: {
            sweepSource: "PostPerformance",
            priorCapturedAt: perf.capturedAt.toISOString(),
          },
        });
      }

      const providerKey =
        providerKeys.size === 1
          ? [...providerKeys][0]
          : providerKeys.size > 1
            ? "multi"
            : null;

      if (observations.length === 0) {
        if (claimEmptySweepHeartbeat(org.id, Date.now())) {
          await recordContinuousCollectionRun({
            organisationId: org.id,
            kind: "scheduled_sweep",
            providerKey,
            status: "COMPLETED",
            itemsCollected: 0,
            metadata: {
              note: "No new PostPerformance engagement since the last snapshot — nothing invented.",
              heartbeat: true,
            },
          });
          runsCreated += 1;
        }
        continue;
      }

      const platformById = new Map(contents.map((c) => [c.id, c.platform]));
      const byProvider = new Map<string, MetricObservation[]>();
      for (const obs of observations) {
        const key = platformById.get(obs.socialContentId) ?? "unknown";
        const list = byProvider.get(key) ?? [];
        list.push(obs);
        byProvider.set(key, list);
      }

      for (const [key, obsList] of byProvider) {
        const result = await runContinuousCollectionPass({
          organisationId: org.id,
          kind: "scheduled_sweep",
          providerKey: key,
          observations: obsList,
          metadata: { sweep: true, honesty: "Copied from existing engagement only." },
        });
        runsCreated += 1;
        snapshotsAppended += result.appended;
      }
    } catch {
      // Skip orgs deleted mid-sweep (parallel tests / hard purge) — never invent metrics.
      continue;
    }
  }

  return {
    orgsProcessed: orgs.length,
    runsCreated,
    snapshotsAppended,
  };
}
