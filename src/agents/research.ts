import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import { completeStructured } from "@/adapters/ai/structured";
import { resolveModelForTier } from "@/lib/ai-models";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { prisma } from "@/lib/db";
import { recordResearchToolCall } from "@/services/research-tool-calls";
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

const findingsExtractSchema = z.object({
  findings: z
    .array(
      z.object({
        claim: z.string().min(1).max(500),
        sourceUrl: z.string().url(),
        evidenceExcerpt: z.string().max(800).optional(),
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
    const maxSources = input.maxSources ?? 20;
    return Math.max(3, Math.ceil(maxSources / 5) + 2);
  },
  userFacingLabel: (input) => {
    const topic = (input.topic || "your topic").trim().slice(0, 80);
    return `Researching “${topic}” across available sources`;
  },
  async execute(input, ctx) {
    const parsed = researchInputSchema.parse(input);
    const maxSources = parsed.maxSources ?? 20;
    await assertWithinSpendCap(ctx.organisationId, researchAgent.estimateCostCents(parsed));

    const model = resolveModelForTier("cheap");
    let costCents = 0;

    const expand = await completeStructured(queryExpandSchema, {
      organisationId: ctx.organisationId,
      tier: "cheap",
      model,
      system:
        "You expand one research question into several targeted search queries. Stay domain-agnostic — never assume Instagram marketing. Cover angles like comparisons, pricing, problems, specs, reviews, and alternatives when relevant. Return JSON only.",
      prompt: `Topic: ${parsed.topic}\nNiche hint (optional): ${parsed.nicheHint || "(none)"}\nProduce 3-6 concrete search queries.`,
      temperature: 0.3,
    });
    costCents += 2;

    const queries = [...new Set([parsed.topic, ...expand.queries.map((q) => q.trim())])].slice(
      0,
      8,
    );

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

    const sourceRows = [];
    for (const r of ranked) {
      const row = await prisma.researchSource.create({
        data: {
          organisationId: ctx.organisationId,
          researchJobId: job.id,
          url: r.url,
          title: r.title,
          platform: r.platform,
          author: r.author,
          publishedAt: r.publishedAt,
          content: r.content.slice(0, 20_000),
          engagement: (r.engagement ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          rawMetadata: r.rawMetadata as Prisma.InputJsonValue,
          queryUsed: parsed.topic,
        },
      });
      sourceRows.push(row);
    }

    const urlToId = new Map(sourceRows.map((s) => [s.url, s.id]));
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
            "Extract factual findings from the sources. Every finding MUST include sourceUrl exactly matching one provided URL. Never invent statistics or URLs. If unsure, omit.",
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

    return { output, model, costCents };
  },
};
