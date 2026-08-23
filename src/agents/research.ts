import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import { completeStructured } from "@/adapters/ai/structured";
import { resolveModelForTier } from "@/lib/ai-models";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { assertEntitlement, recordMeteredUsage } from "@/services/entitlements";
import { prisma } from "@/lib/db";
import { recordResearchToolCall } from "@/services/research-tool-calls";
import {
  parseClaimKind,
  persistResearchSourceWithSnapshot,
} from "@/services/research-evidence";
import { ingestResearchJobSocialContent } from "@/services/social-intelligence";
import {
  dedupeSourceResults,
  formatUnavailableSourceNotes,
  listConfiguredSourcePlatforms,
  rankSourceResults,
  searchConfiguredSources,
  type SourcePlatform,
  type SourceResult,
} from "@/adapters/sources";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export const researchInputSchema = z.object({
  topic: z.string().min(3).max(2000),
  /** Optional niche / industry hint — never assumed to be Instagram marketing. */
  nicheHint: z.string().max(200).optional(),
  maxSources: z.number().int().min(5).max(40).optional(),
  platforms: z
    .array(z.enum(["youtube", "reddit", "web", "instagram", "linkedin", "tiktok"]))
    .optional(),
});

const findingSchema = z.object({
  claim: z.string().min(1),
  sourceUrl: z.string().url(),
  evidenceExcerpt: z.string().optional(),
  claimKind: z
    .enum(["OFFICIAL", "OBSERVATION", "INFERENCE", "SECONDARY", "UNKNOWN"])
    .optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const researchOutputSchema = z.object({
  researchJobId: z.string(),
  topic: z.string(),
  queries: z.array(z.string()),
  sourceCount: z.number().int().nonnegative(),
  findings: z.array(findingSchema),
  sources: z.array(
    z.object({
      url: z.string().url(),
      title: z.string(),
      platform: z.string(),
    }),
  ),
  summary: z.string(),
  adapterErrors: z.array(z.object({ platform: z.string(), message: z.string() })),
});

export type ResearchInput = z.infer<typeof researchInputSchema>;
export type ResearchOutput = z.infer<typeof researchOutputSchema>;

const queryExpandSchema = z.object({
  queries: z.array(z.string().min(2).max(200)).min(2).max(8),
});

/** Coerce common Claude shapes into { queries: string[] }. */
function coerceQueryExpand(raw: unknown): { queries: string[] } | null {
  if (!raw || typeof raw !== "object") {
    if (Array.isArray(raw) && raw.every((q) => typeof q === "string")) {
      return { queries: raw as string[] };
    }
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const candidates = [obj.queries, obj.search_queries, obj.searchQueries, obj.q];
  for (const c of candidates) {
    if (Array.isArray(c) && c.every((q) => typeof q === "string")) {
      return { queries: c as string[] };
    }
    if (typeof c === "string") {
      const parts = c
        .split(/\n|,/)
        .map((q) => q.trim())
        .filter((q) => q.length >= 2);
      if (parts.length >= 1) return { queries: parts };
    }
  }
  return null;
}

async function expandResearchQueries(input: {
  organisationId: string;
  topic: string;
  nicheHint?: string;
  model: string;
  knowledgeContext?: string | null;
}): Promise<string[]> {
  const system =
    'You expand one research question into several targeted search queries for recent viral social content. Return ONLY a JSON object shaped exactly like {"queries":["query one","query two","query three"]}. No markdown.';
  const knowledgeBlock = input.knowledgeContext?.trim()
    ? `\nInternal company context (use only to focus queries — do not invent sources from it):\n${input.knowledgeContext.slice(0, 3000)}\n`
    : "";
  const prompt = `Topic: ${input.topic}
Niche hint (optional): ${input.nicheHint || "(none)"}
${knowledgeBlock}Produce 4-8 concrete search queries as JSON that find the MOST RECENT viral / trending posts and videos (YouTube, TikTok, Instagram, Reddit, news).
Include query variants with words like: this week, trending, viral, algorithm, shorts, reel, what people are saying.`;

  try {
    const expand = await completeStructured(queryExpandSchema, {
      organisationId: input.organisationId,
      tier: "cheap",
      model: input.model,
      system,
      prompt,
      temperature: 0.2,
      repairHint: 'Required shape: {"queries":["...","..."]}. The "queries" array is required.',
    });
    return expand.queries.map((q) => q.trim()).filter(Boolean);
  } catch (error) {
    // Last resort: try a raw completion + coerce so research still reaches YouTube/web.
    try {
      const { getAiProvider } = await import("@/adapters/ai");
      const { tryParseJson } = await import("@/adapters/ai/structured");
      const text = await getAiProvider().complete({
        model: input.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      });
      const parsed = tryParseJson(text);
      const coerced = coerceQueryExpand(parsed);
      if (coerced && coerced.queries.length >= 1) {
        return coerced.queries.map((q) => q.trim()).filter(Boolean).slice(0, 8);
      }
    } catch {
      // fall through
    }
    logger.warn("Research query expand failed — continuing with the original topic only", {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

const findingsExtractSchema = z.object({
  findings: z
    .array(
      z.object({
        claim: z.string().min(1).max(500),
        sourceUrl: z.string().url(),
        evidenceExcerpt: z.string().max(800).optional(),
        claimKind: z
          .enum(["OFFICIAL", "OBSERVATION", "INFERENCE", "SECONDARY", "UNKNOWN"])
          .optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(40),
});

function engagementScore(r: SourceResult): number {
  return r.engagement?.score ?? r.engagement?.views ?? r.engagement?.likes ?? 0;
}

/**
 * Research agent — expands a question, searches configured sources in parallel,
 * ranks/dedupes, and records findings that each carry a source URL.
 */
export const researchAgent: Agent<ResearchInput, ResearchOutput> = {
  name: "research",
  description:
    "Researches a topic across configured web and social sources, returning findings with source URLs only.",
  inputSchema: researchInputSchema,
  outputSchema: researchOutputSchema,
  tier: "cheap",
  estimateCostCents: (input) => {
    const maxSources = input.maxSources ?? 28;
    return Math.max(3, Math.ceil(maxSources / 5) + 2);
  },
  userFacingLabel: (input) => {
    const topic = (input.topic || "your topic").trim().slice(0, 80);
    return `Researching “${topic}” across available sources`;
  },
  async execute(input, ctx) {
    const parsed = researchInputSchema.parse(input);
    const maxSources = parsed.maxSources ?? 28;
    await assertEntitlement(ctx.organisationId, "research");
    await assertWithinSpendCap(ctx.organisationId, researchAgent.estimateCostCents(parsed));

    const model = resolveModelForTier("cheap");
    let costCents = 0;

    const expanded = await expandResearchQueries({
      organisationId: ctx.organisationId,
      topic: parsed.topic,
      nicheHint: parsed.nicheHint,
      model,
      knowledgeContext: ctx.knowledgeContext,
    });
    costCents += 2;

    const queries = [...new Set([parsed.topic, ...expanded])].slice(0, 8);

    const job = await prisma.researchJob.create({
      data: {
        organisationId: ctx.organisationId,
        agentRunId: ctx.agentRunId,
        kind: "RESEARCH",
        topic: parsed.topic,
        status: "RUNNING",
        queries,
        startedAt: new Date(),
      },
    });

    const platforms = (parsed.platforms as SourcePlatform[] | undefined)?.length
      ? (parsed.platforms as SourcePlatform[])
      : listConfiguredSourcePlatforms();

    const concurrency = Number(getEnv().RESEARCH_ADAPTER_CONCURRENCY || 3);
    const collected: SourceResult[] = [];
    const adapterErrors: Array<{ platform: string; message: string }> = [];

    for (const query of queries) {
      const started = Date.now();
      try {
        const { results, errors, billableCents } = await searchConfiguredSources({
          query,
          platforms,
          concurrency,
          options: {
            organisationId: ctx.organisationId,
            limit: Math.ceil(maxSources / Math.max(queries.length, 1)) + 2,
            recent: true,
            nicheHint: parsed.nicheHint,
          },
        });
        collected.push(...results);
        costCents += billableCents;
        for (const err of errors) {
          adapterErrors.push({ platform: err.platform, message: err.message });
        }
        await recordResearchToolCall({
          organisationId: ctx.organisationId,
          agentStepId: ctx.agentStepId,
          toolName: "source.search",
          args: { query, platforms, organisationId: ctx.organisationId },
          result: {
            count: results.length,
            urls: results.map((r) => r.url).slice(0, 40),
            errors: errors.map((e) => ({ platform: e.platform, code: e.code })),
          },
          durationMs: Date.now() - started,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "search failed";
        adapterErrors.push({ platform: "web", message });
        await recordResearchToolCall({
          organisationId: ctx.organisationId,
          agentStepId: ctx.agentStepId,
          toolName: "source.search",
          args: { query, platforms, organisationId: ctx.organisationId },
          error: message,
          durationMs: Date.now() - started,
        });
      }
    }

    const ranked = rankSourceResults(dedupeSourceResults(collected)).slice(0, maxSources);

    const sourceRows: Array<{ id: string; url: string; freshnessScore: number | null }> = [];
    for (const r of ranked) {
      const persisted = await persistResearchSourceWithSnapshot({
        organisationId: ctx.organisationId,
        researchJobId: job.id,
        url: r.url,
        title: r.title,
        platform: r.platform,
        author: r.author,
        publishedAt: r.publishedAt,
        content: r.content,
        engagement: (r.engagement ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        rawMetadata: r.rawMetadata as Prisma.InputJsonValue,
        queryUsed: parsed.topic,
      });
      sourceRows.push({
        id: persisted.sourceId,
        url: r.url,
        freshnessScore: persisted.freshnessScore,
      });
    }

    const urlToId = new Map(sourceRows.map((s) => [s.url, s.id]));
    const urlToFreshness = new Map(sourceRows.map((s) => [s.url, s.freshnessScore]));
    const catalog = ranked
      .map(
        (r) =>
          `URL: ${r.url}\nTitle: ${r.title}\nPlatform: ${r.platform}\nEngagement: ${engagementScore(r)}\nExcerpt:\n${r.content.slice(0, 1200)}`,
      )
      .join("\n\n----\n\n");

    await assertWithinSpendCap(ctx.organisationId, 2);
    const extracted = catalog
      ? await completeStructured(findingsExtractSchema, {
          organisationId: ctx.organisationId,
          tier: "cheap",
          model,
          system:
            'Extract factual findings from the sources. Every finding MUST include sourceUrl exactly matching one provided URL. Prefer claimKind OFFICIAL (primary docs), OBSERVATION (what happened), INFERENCE (your reasoned take), or SECONDARY (repost/summary). Include a short evidenceExcerpt copied from the source when possible. Never invent statistics or URLs. If unsure, omit.',
          prompt: `Topic: ${parsed.topic}\n\nSources:\n${catalog.slice(0, 60_000)}\n\nReturn up to ${Math.min(maxSources, 25)} findings.`,
          temperature: 0.1,
        })
      : { findings: [] };
    costCents += 2;

    const allowedUrls = new Set(ranked.map((r) => r.url));
    const findings = extracted.findings.filter((f) => allowedUrls.has(f.sourceUrl));

    for (const f of findings) {
      const sourceId = urlToId.get(f.sourceUrl);
      if (!sourceId) continue;
      await prisma.researchFinding.create({
        data: {
          organisationId: ctx.organisationId,
          researchJobId: job.id,
          researchSourceId: sourceId,
          claim: f.claim,
          evidenceExcerpt: f.evidenceExcerpt,
          claimKind: parseClaimKind(f.claimKind),
          confidence: f.confidence ?? null,
          freshnessScore: urlToFreshness.get(f.sourceUrl) ?? null,
        },
      });
    }

    const unavailableNotes = formatUnavailableSourceNotes(adapterErrors);
    const baseSummary =
      findings.length > 0
        ? `Found ${findings.length} sourced finding${findings.length === 1 ? "" : "s"} from ${ranked.length} sources.`
        : ranked.length > 0
          ? `Gathered ${ranked.length} sources but could not extract grounded findings yet.`
          : "No sources were returned from the configured adapters.";
    const summary = [baseSummary, ...unavailableNotes].join(" ").trim();

    const output: ResearchOutput = {
      researchJobId: job.id,
      topic: parsed.topic,
      queries,
      sourceCount: ranked.length,
      findings,
      sources: ranked.map((r) => ({ url: r.url, title: r.title, platform: r.platform })),
      summary,
      adapterErrors: adapterErrors.slice(0, 20),
    };

    await prisma.researchJob.updateMany({
      where: { id: job.id, organisationId: ctx.organisationId },
      data: {
        status: ranked.length ? "COMPLETED" : "FAILED",
        brief: output as unknown as Prisma.InputJsonValue,
        totalCostCents: costCents,
        finishedAt: new Date(),
        userFacingError: ranked.length
          ? null
          : "I couldn't reach any research sources. Check that YouTube, Reddit, or web search keys are configured.",
        error: ranked.length ? null : "no_sources",
      },
    });

    if (ranked.length) {
      try {
        await recordMeteredUsage({
          organisationId: ctx.organisationId,
          feature: "research",
          metadata: { researchJobId: job.id },
        });
      } catch {
        /* metering must not fail the research output */
      }
      try {
        await ingestResearchJobSocialContent({
          organisationId: ctx.organisationId,
          researchJobId: job.id,
        });
      } catch (error) {
        logger.warn("Social intelligence ingest skipped after research", {
          researchJobId: job.id,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    return { output, model, costCents };
  },
};
