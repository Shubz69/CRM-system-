/**
 * Continuous collection runs + append-only SocialMetricSnapshot history.
 * Never overwrite prior totals; missing platform metrics stay explicit nulls.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

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
 * Always inserts new rows — never updates an existing SocialMetricSnapshot.
 */
export async function appendMetricHistory(input: {
  organisationId: string;
  observations: MetricObservation[];
}): Promise<{
  appended: number;
  skippedEmpty: number;
  skippedUnknownContent: number;
  missingMetricNotes: Array<{ socialContentId: string; missingMetrics: string[] }>;
  snapshotIds: string[];
}> {
  let appended = 0;
  let skippedEmpty = 0;
  let skippedUnknownContent = 0;
  const missingMetricNotes: Array<{ socialContentId: string; missingMetrics: string[] }> = [];
  const snapshotIds: string[] = [];

  for (const obs of input.observations) {
    const content = await prisma.socialContent.findFirst({
      where: { id: obs.socialContentId, organisationId: input.organisationId },
      select: { id: true },
    });
    if (!content) {
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
    const raw: Record<string, unknown> = {
      ...(obs.raw ?? {}),
      missingMetrics,
      appendOnly: true,
    };

    const snap = await prisma.socialMetricSnapshot.create({
      data: {
        organisationId: input.organisationId,
        socialContentId: obs.socialContentId,
        capturedAt,
        views: obs.views ?? null,
        likes: obs.likes ?? null,
        comments: obs.comments ?? null,
        shares: obs.shares ?? null,
        score: obs.score ?? null,
        raw: raw as Prisma.InputJsonValue,
      },
    });
    snapshotIds.push(snap.id);
    appended += 1;

    await prisma.socialContent.update({
      where: { id: obs.socialContentId },
      data: { lastSeenAt: capturedAt },
    });
  }

  return { appended, skippedEmpty, skippedUnknownContent, missingMetricNotes, snapshotIds };
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
      missingMetricNotes: appendResult.missingMetricNotes.slice(0, 50),
      honesty:
        "Platform metrics that were not returned are recorded as null + listed in missingMetrics — never invented.",
    },
  });

  return { run, ...appendResult };
}

/**
 * Postgres sweep: for each org, record a scheduled ContinuousCollectionRun and
 * append snapshots from latest PostPerformance / SocialContent engagement when present.
 * Never invents metrics — skips content with no observed engagement fields.
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
        where: { deletedAt: null, isPlatform: false },
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

      const observations: MetricObservation[] = [];
      const providerKeys = new Set<string>();

      for (const content of contents) {
        providerKeys.add(content.platform);

        const latestSnap = await prisma.socialMetricSnapshot.findFirst({
          where: { organisationId: org.id, socialContentId: content.id },
          orderBy: { capturedAt: "desc" },
          select: {
            views: true,
            likes: true,
            comments: true,
            shares: true,
            score: true,
            capturedAt: true,
          },
        });

        const latestPerf =
          latestSnap == null
            ? await prisma.postPerformance.findFirst({
                where: {
                  organisationId: org.id,
                  socialContentId: content.id,
                },
                orderBy: { capturedAt: "desc" },
                select: {
                  views: true,
                  likes: true,
                  comments: true,
                  shares: true,
                  capturedAt: true,
                },
              })
            : null;

        const source = latestSnap ?? latestPerf;
        if (!source) continue;

        const views = source.views ?? null;
        const likes = source.likes ?? null;
        const comments = source.comments ?? null;
        const shares = source.shares ?? null;
        const score =
          latestSnap && "score" in latestSnap ? (latestSnap.score ?? null) : null;

        if (
          views == null &&
          likes == null &&
          comments == null &&
          shares == null &&
          score == null
        ) {
          continue;
        }

        observations.push({
          socialContentId: content.id,
          capturedAt: new Date(),
          views,
          likes,
          comments,
          shares,
          score,
          raw: {
            sweepSource: latestSnap ? "SocialMetricSnapshot" : "PostPerformance",
            priorCapturedAt: source.capturedAt.toISOString(),
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
        await recordContinuousCollectionRun({
          organisationId: org.id,
          kind: "scheduled_sweep",
          providerKey,
          status: "COMPLETED",
          itemsCollected: 0,
          metadata: {
            note: "No existing PostPerformance/SocialContent engagement to snapshot — nothing invented.",
          },
        });
        runsCreated += 1;
        continue;
      }

      const byProvider = new Map<string, MetricObservation[]>();
      for (const obs of observations) {
        const content = contents.find((c) => c.id === obs.socialContentId);
        const key = content?.platform ?? "unknown";
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

