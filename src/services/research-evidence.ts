/**
 * Research Evidence Fabric helpers — freshness, hashing, excerpt grounding, snapshots.
 */

import { createHash } from "crypto";
import { Prisma, ResearchClaimKind } from "@prisma/client";
import { prisma } from "@/lib/db";

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "for",
  "on",
  "is",
  "are",
  "with",
  "this",
  "that",
  "from",
  "was",
  "were",
  "been",
  "have",
  "has",
  "had",
  "not",
  "but",
  "they",
  "their",
  "about",
]);

export function normalizeEvidenceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashSourceContent(content: string | null | undefined): string | null {
  if (!content?.trim()) return null;
  return createHash("sha256").update(normalizeEvidenceText(content)).digest("hex");
}

/** 0–1 freshness from publishedAt relative to `asOf` (usually retrieval time). */
export function computeFreshnessScore(
  publishedAt: Date | null | undefined,
  asOf: Date = new Date(),
): number | null {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return null;
  const ageMs = asOf.getTime() - publishedAt.getTime();
  if (ageMs < 0) return 1;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.75;
  if (ageDays <= 90) return 0.5;
  if (ageDays <= 365) return 0.3;
  return 0.15;
}

export function parseClaimKind(value: unknown): ResearchClaimKind {
  if (typeof value !== "string") return ResearchClaimKind.UNKNOWN;
  const key = value.trim().toUpperCase();
  const allowed = new Set<string>(Object.values(ResearchClaimKind));
  if (allowed.has(key)) return key as ResearchClaimKind;
  return ResearchClaimKind.UNKNOWN;
}

function significantTokens(text: string): string[] {
  return normalizeEvidenceText(text)
    .split(" ")
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * True when evidence excerpt (preferred) or claim tokens appear in source body.
 * When the source has no stored body (e.g. title-only YouTube hits), grounding is skipped
 * — URL membership remains the hard gate; do not fail Ask runs as ungrounded.
 */
export function isExcerptGrounded(input: {
  claim: string;
  evidenceExcerpt?: string | null;
  sourceContent?: string | null;
}): { grounded: boolean; skipped: boolean; reason: string } {
  const body = input.sourceContent?.trim();
  if (!body) {
    return {
      grounded: true,
      skipped: true,
      reason: "Source has no stored content — grounding skipped; URL check still applies",
    };
  }
  const normalisedBody = normalizeEvidenceText(body);

  const excerpt = input.evidenceExcerpt?.trim();
  if (excerpt && excerpt.length >= 12) {
    const needle = normalizeEvidenceText(excerpt);
    if (needle.length >= 12 && normalisedBody.includes(needle)) {
      return { grounded: true, skipped: false, reason: "Evidence excerpt found in source content" };
    }
    // Allow loose match: ≥60% of excerpt tokens present in body
    const tokens = significantTokens(excerpt);
    if (tokens.length >= 3) {
      const hits = tokens.filter((t) => normalisedBody.includes(t)).length;
      if (hits / tokens.length >= 0.6) {
        return {
          grounded: true,
          skipped: false,
          reason: "Most evidence excerpt tokens found in source content",
        };
      }
    }
    return { grounded: false, skipped: false, reason: "Evidence excerpt not found in source content" };
  }

  const claimTokens = significantTokens(input.claim);
  if (claimTokens.length < 3) {
    return {
      grounded: false,
      skipped: false,
      reason: "Claim too short to ground without an evidence excerpt",
    };
  }
  const hits = claimTokens.filter((t) => normalisedBody.includes(t)).length;
  if (hits / claimTokens.length >= 0.5) {
    return {
      grounded: true,
      skipped: false,
      reason: "Claim tokens sufficiently overlap source content",
    };
  }
  return { grounded: false, skipped: false, reason: "Claim not grounded in source content" };
}

export async function persistResearchSourceWithSnapshot(input: {
  organisationId: string;
  researchJobId: string;
  url: string;
  title?: string | null;
  platform: string;
  author?: string | null;
  publishedAt?: Date | null;
  content?: string | null;
  engagement?: Prisma.InputJsonValue;
  rawMetadata?: Prisma.InputJsonValue;
  queryUsed?: string | null;
}): Promise<{ sourceId: string; snapshotId: string; freshnessScore: number | null }> {
  const retrievedAt = new Date();
  const content = input.content?.slice(0, 20_000) ?? null;
  const contentHash = hashSourceContent(content);
  const freshnessScore = computeFreshnessScore(input.publishedAt ?? null, retrievedAt);

  const source = await prisma.researchSource.create({
    data: {
      organisationId: input.organisationId,
      researchJobId: input.researchJobId,
      url: input.url,
      title: input.title ?? null,
      platform: input.platform,
      author: input.author ?? null,
      publishedAt: input.publishedAt ?? null,
      retrievedAt,
      content,
      contentHash,
      freshnessScore,
      engagement: (input.engagement ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      rawMetadata: (input.rawMetadata ?? {}) as Prisma.InputJsonValue,
      queryUsed: input.queryUsed ?? null,
    },
  });

  const snapshot = await prisma.researchSourceSnapshot.create({
    data: {
      organisationId: input.organisationId,
      researchJobId: input.researchJobId,
      researchSourceId: source.id,
      url: input.url,
      title: input.title ?? null,
      platform: input.platform,
      author: input.author ?? null,
      publishedAt: input.publishedAt ?? null,
      retrievedAt,
      content,
      contentHash,
      engagement: (input.engagement ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      rawMetadata: (input.rawMetadata ?? {}) as Prisma.InputJsonValue,
    },
  });

  return { sourceId: source.id, snapshotId: snapshot.id, freshnessScore };
}
