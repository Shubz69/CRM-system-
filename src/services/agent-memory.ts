/**
 * Agent Memory V2 — episodic / entity / performance / preference.
 * KnowledgeDocument remains the only approved company truth store.
 * Agents must never silent-promote research into Knowledge (see assertKnowledgePromotionPolicy).
 */

import { MemoryEntityFactStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

const EPISODE_TTL_DAYS = 90;
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
  "what",
  "how",
  "when",
  "where",
  "why",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function scoreOverlap(queryTokens: string[], haystack: string): number {
  if (!queryTokens.length) return 0;
  const set = new Set(tokenize(haystack));
  let hits = 0;
  for (const t of queryTokens) {
    if (set.has(t)) hits += 1;
  }
  return hits / queryTokens.length;
}

function excerptSummary(finalOutput: unknown, request: string): string {
  if (finalOutput && typeof finalOutput === "object") {
    const o = finalOutput as Record<string, unknown>;
    const short =
      (typeof o.shortAnswer === "string" && o.shortAnswer.trim()) ||
      (typeof o.summary === "string" && o.summary.trim()) ||
      "";
    if (short) return short.slice(0, 1200);
  }
  return `Ask run: ${request.slice(0, 400)}`;
}

export async function recordEpisodeFromAgentRun(input: {
  organisationId: string;
  agentRunId: string;
  request: string;
  status: string;
  finalOutput?: unknown;
  kind?: string;
}): Promise<string | null> {
  if (!["COMPLETED", "PARTIAL"].includes(input.status)) return null;

  const existing = await prisma.memoryEpisode.findFirst({
    where: {
      organisationId: input.organisationId,
      agentRunId: input.agentRunId,
    },
    select: { id: true },
  });
  if (existing) return existing.id;

  const expiresAt = new Date();
  expiresAt.setUTCDate(expiresAt.getUTCDate() + EPISODE_TTL_DAYS);

  const row = await prisma.memoryEpisode.create({
    data: {
      organisationId: input.organisationId,
      agentRunId: input.agentRunId,
      kind: input.kind ?? "ask",
      summary: excerptSummary(input.finalOutput, input.request),
      requestPreview: input.request.slice(0, 800),
      outcomeStatus: input.status,
      tags: ["ask", "auto"],
      metadata: {
        recordedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
      expiresAt,
    },
  });
  return row.id;
}

export async function retrieveRelevantEpisodes(input: {
  organisationId: string;
  query: string;
  limit?: number;
}): Promise<{
  episodes: Array<{ id: string; summary: string; requestPreview: string | null; createdAt: Date }>;
  contextText: string | null;
}> {
  const limit = Math.min(Math.max(input.limit ?? 4, 1), 12);
  const now = new Date();
  const recent = await prisma.memoryEpisode.findMany({
    where: {
      organisationId: input.organisationId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: {
      id: true,
      summary: true,
      requestPreview: true,
      createdAt: true,
    },
  });

  const tokens = tokenize(input.query);
  const ranked = recent
    .map((e) => ({
      ...e,
      score: Math.max(
        scoreOverlap(tokens, `${e.requestPreview || ""} ${e.summary}`),
        // Mild recency bias so empty-token queries still get latest episodes
        0.05,
      ),
    }))
    .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);

  const meaningful = ranked.filter((e) => e.score >= 0.08 || tokens.length === 0);
  const episodes = meaningful.map(({ id, summary, requestPreview, createdAt }) => ({
    id,
    summary,
    requestPreview,
    createdAt,
  }));

  if (!episodes.length) {
    return { episodes: [], contextText: null };
  }

  const contextText = [
    "Prior Ask episodes (working memory — not approved Knowledge):",
    ...episodes.map(
      (e, i) =>
        `${i + 1}. ${e.summary.slice(0, 500)}${
          e.requestPreview ? ` [was about: ${e.requestPreview.slice(0, 120)}]` : ""
        }`,
    ),
  ]
    .join("\n")
    .slice(0, 6_000);

  return { episodes, contextText };
}

export async function upsertEntityFact(input: {
  organisationId: string;
  entityType: string;
  entityKey: string;
  factKey: string;
  factValue: string;
  confidence?: number;
  provenance: {
    sourceType: string;
    sourceId?: string;
    excerpt?: string;
  };
  status?: MemoryEntityFactStatus;
}): Promise<string> {
  if (!input.provenance?.sourceType?.trim()) {
    throw new Error("Entity facts require provenance.sourceType");
  }
  const provenance = {
    ...input.provenance,
    recordedAt: new Date().toISOString(),
  };

  const row = await prisma.memoryEntityFact.upsert({
    where: {
      organisationId_entityType_entityKey_factKey: {
        organisationId: input.organisationId,
        entityType: input.entityType.trim(),
        entityKey: input.entityKey.trim(),
        factKey: input.factKey.trim(),
      },
    },
    create: {
      organisationId: input.organisationId,
      entityType: input.entityType.trim(),
      entityKey: input.entityKey.trim(),
      factKey: input.factKey.trim(),
      factValue: input.factValue,
      confidence: input.confidence ?? 0.5,
      provenance: provenance as Prisma.InputJsonValue,
      status: input.status ?? MemoryEntityFactStatus.CANDIDATE,
    },
    update: {
      factValue: input.factValue,
      confidence: input.confidence ?? 0.5,
      provenance: provenance as Prisma.InputJsonValue,
      ...(input.status ? { status: input.status } : {}),
    },
  });
  return row.id;
}

export async function recordPerformanceOutcome(input: {
  organisationId: string;
  kind: string;
  metric: string;
  value: number;
  unit?: string;
  subjectKey?: string;
  sourceRef?: string;
  measuredAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const row = await prisma.memoryPerformanceOutcome.create({
    data: {
      organisationId: input.organisationId,
      kind: input.kind,
      metric: input.metric,
      value: input.value,
      unit: input.unit ?? null,
      subjectKey: input.subjectKey ?? null,
      sourceRef: input.sourceRef ?? null,
      measuredAt: input.measuredAt ?? new Date(),
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
  return row.id;
}

export async function getOrganisationPreferences(input: {
  organisationId: string;
}): Promise<Record<string, unknown>> {
  const rows = await prisma.organisationPreference.findMany({
    where: { organisationId: input.organisationId },
    select: { key: true, value: true },
  });
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    out[row.key] = row.value;
  }
  return out;
}

export async function setOrganisationPreference(input: {
  organisationId: string;
  key: string;
  value: unknown;
  updatedByUserId?: string | null;
}): Promise<void> {
  await prisma.organisationPreference.upsert({
    where: {
      organisationId_key: {
        organisationId: input.organisationId,
        key: input.key.trim(),
      },
    },
    create: {
      organisationId: input.organisationId,
      key: input.key.trim(),
      value: input.value as Prisma.InputJsonValue,
      updatedByUserId: input.updatedByUserId ?? null,
    },
    update: {
      value: input.value as Prisma.InputJsonValue,
      updatedByUserId: input.updatedByUserId ?? null,
    },
  });
}

/**
 * Research / Ask drafts must never land as ACTIVE Knowledge without explicit human review.
 * Call from knowledge write APIs before upsert.
 */
export function assertKnowledgePromotionPolicy(input: {
  category?: string | null;
  tags?: string[] | null;
  status?: string | null;
}): { ok: true; forcedStatus?: "INACTIVE" } | { ok: false; error: string } {
  const tags = input.tags ?? [];
  const fromAskOrResearch =
    tags.includes("from-ask") ||
    tags.includes("draft") ||
    (input.category || "").toLowerCase() === "research";

  if (!fromAskOrResearch) return { ok: true };

  if (input.status === "ACTIVE") {
    return {
      ok: false,
      error:
        "Ask/research drafts cannot be activated automatically. Save as an inactive draft, then activate from Knowledge after review.",
    };
  }

  return { ok: true, forcedStatus: "INACTIVE" };
}

export function formatPreferencesForContext(prefs: Record<string, unknown>): string | null {
  const tone = prefs.tone ?? prefs.responseTone;
  const style = prefs.operatingStyle ?? prefs.style;
  const lines: string[] = [];
  if (typeof tone === "string" && tone.trim()) lines.push(`Tone preference: ${tone.trim()}`);
  if (typeof style === "string" && style.trim()) {
    lines.push(`Operating style: ${style.trim()}`);
  }
  if (!lines.length) return null;
  return ["Organisation preferences (admin-set):", ...lines].join("\n");
}
