/**
 * Phase 4 Social Intelligence — upsert canonical content + append metric snapshots.
 * Never overwrite prior metric totals; always insert a new snapshot when engagement is present.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SourceEngagement } from "@/adapters/sources/types";

function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  return raw.trim().replace(/^@/, "").toLowerCase().slice(0, 200);
}

export function inferContentFormat(input: {
  platform: string;
  url: string;
  title?: string | null;
}): string {
  const url = input.url.toLowerCase();
  if (/youtube\.com\/shorts|youtu\.be\/.*shorts|\/shorts\//.test(url)) return "short";
  if (/instagram\.com\/reel|\/reels\//.test(url)) return "reel";
  if (/tiktok\.com\//.test(url)) return "short";
  if (/threads\.net\//.test(url) || input.platform === "threads") return "thread";
  if (/twitter\.com\/|x\.com\//.test(url)) return "post";
  if (/youtube\.com\/watch|youtu\.be\//.test(url)) return "video";
  return "other";
}

function engagementNumbers(engagement: SourceEngagement | null | undefined): {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  score: number | null;
  hasAny: boolean;
} {
  const views = engagement?.views ?? null;
  const likes = engagement?.likes ?? null;
  const comments = engagement?.comments ?? null;
  const shares = engagement?.shares ?? null;
  const score =
    engagement?.score != null
      ? Number(engagement.score)
      : views != null || likes != null
        ? Number(views ?? 0) + Number(likes ?? 0) * 10
        : null;
  const hasAny =
    views != null || likes != null || comments != null || shares != null || score != null;
  return { views, likes, comments, shares, score, hasAny };
}

export async function upsertSocialContentFromSource(input: {
  organisationId: string;
  platform: string;
  url: string;
  title?: string | null;
  body?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  engagement?: SourceEngagement | null;
  rawMetadata?: Record<string, unknown> | null;
  topics?: string[];
  researchSourceId?: string | null;
  socialPostId?: string | null;
  externalId?: string | null;
  /** When false, skip writing a metric snapshot even if engagement exists. */
  captureMetrics?: boolean;
}): Promise<{ contentId: string; creatorId: string | null; snapshotId: string | null }> {
  const handle = normalizeHandle(input.author);
  let creatorId: string | null = null;
  if (handle) {
    const creator = await prisma.socialCreator.upsert({
      where: {
        organisationId_platform_handle: {
          organisationId: input.organisationId,
          platform: input.platform,
          handle,
        },
      },
      create: {
        organisationId: input.organisationId,
        platform: input.platform,
        handle,
        displayName: input.author?.trim() || handle,
        metadata: {} as Prisma.InputJsonValue,
      },
      update: {
        displayName: input.author?.trim() || undefined,
      },
    });
    creatorId = creator.id;
  }

  const format = inferContentFormat({
    platform: input.platform,
    url: input.url,
    title: input.title,
  });
  const now = new Date();

  const content = await prisma.socialContent.upsert({
    where: {
      organisationId_platform_url: {
        organisationId: input.organisationId,
        platform: input.platform,
        url: input.url,
      },
    },
    create: {
      organisationId: input.organisationId,
      platform: input.platform,
      url: input.url,
      externalId: input.externalId ?? null,
      creatorId,
      title: input.title ?? null,
      body: input.body?.slice(0, 20_000) ?? null,
      publishedAt: input.publishedAt ?? null,
      format,
      topics: input.topics ?? [],
      researchSourceId: input.researchSourceId ?? null,
      socialPostId: input.socialPostId ?? null,
      rawMetadata: (input.rawMetadata ?? {}) as Prisma.InputJsonValue,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {
      creatorId: creatorId ?? undefined,
      title: input.title ?? undefined,
      body: input.body?.slice(0, 20_000) ?? undefined,
      publishedAt: input.publishedAt ?? undefined,
      format,
      topics: input.topics?.length ? input.topics : undefined,
      researchSourceId: input.researchSourceId ?? undefined,
      socialPostId: input.socialPostId ?? undefined,
      rawMetadata: input.rawMetadata
        ? (input.rawMetadata as Prisma.InputJsonValue)
        : undefined,
      lastSeenAt: now,
    },
  });

  let snapshotId: string | null = null;
  const metrics = engagementNumbers(input.engagement);
  if (input.captureMetrics !== false && metrics.hasAny) {
    const snap = await prisma.socialMetricSnapshot.create({
      data: {
        organisationId: input.organisationId,
        socialContentId: content.id,
        capturedAt: now,
        views: metrics.views,
        likes: metrics.likes,
        comments: metrics.comments,
        shares: metrics.shares,
        score: metrics.score,
        raw: (input.engagement ?? {}) as Prisma.InputJsonValue,
      },
    });
    snapshotId = snap.id;
  }

  return { contentId: content.id, creatorId, snapshotId };
}

/** Backfill / ingest all ResearchSource rows for a job into SocialContent. */
export async function ingestResearchJobSocialContent(input: {
  organisationId: string;
  researchJobId: string;
}): Promise<{ upserted: number; snapshots: number }> {
  const sources = await prisma.researchSource.findMany({
    where: {
      organisationId: input.organisationId,
      researchJobId: input.researchJobId,
    },
  });

  let upserted = 0;
  let snapshots = 0;
  for (const s of sources) {
    const engagement =
      s.engagement && typeof s.engagement === "object"
        ? (s.engagement as SourceEngagement)
        : null;
    const result = await upsertSocialContentFromSource({
      organisationId: input.organisationId,
      platform: s.platform,
      url: s.url,
      title: s.title,
      body: s.content,
      author: s.author,
      publishedAt: s.publishedAt,
      engagement,
      rawMetadata:
        s.rawMetadata && typeof s.rawMetadata === "object"
          ? (s.rawMetadata as Record<string, unknown>)
          : {},
      researchSourceId: s.id,
    });
    upserted += 1;
    if (result.snapshotId) snapshots += 1;
  }
  return { upserted, snapshots };
}
