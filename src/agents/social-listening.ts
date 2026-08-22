import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import { completeStructured } from "@/adapters/ai/structured";
import { resolveModelForTier } from "@/lib/ai-models";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { prisma } from "@/lib/db";
import { recordResearchToolCall } from "@/services/research-tool-calls";
import { persistResearchSourceWithSnapshot } from "@/services/research-evidence";
import {
  dedupeSourceResults,
  formatUnavailableSourceNotes,
  listConfiguredSourcePlatforms,
  mapPool,
  rankSourceResults,
  searchConfiguredSources,
  type SourceResult,
} from "@/adapters/sources";
import { getEnv } from "@/lib/env";

export const socialListeningInputSchema = z.object({
  topic: z.string().min(3).max(2000),
  nicheHint: z.string().max(200).optional(),
  maxPosts: z.number().int().min(5).max(40).optional(),
});

const postExtractSchema = z.object({
  themes: z.array(z.string().max(120)).max(8),
  hooks: z.array(z.string().max(200)).max(8),
  formats: z.array(z.string().max(120)).max(6),
  questions: z.array(z.string().max(200)).max(8),
  complaints: z.array(z.string().max(200)).max(8),
});

export const socialListeningOutputSchema = z.object({
  researchJobId: z.string(),
  topic: z.string(),
  postCount: z.number().int().nonnegative(),
  themes: z.array(z.object({ label: z.string(), frequency: z.number(), evidenceUrls: z.array(z.string()) })),
  hooks: z.array(z.object({ label: z.string(), frequency: z.number(), evidenceUrls: z.array(z.string()) })),
  formats: z.array(z.object({ label: z.string(), frequency: z.number(), evidenceUrls: z.array(z.string()) })),
  questions: z.array(z.object({ label: z.string(), frequency: z.number(), evidenceUrls: z.array(z.string()) })),
  complaints: z.array(z.object({ label: z.string(), frequency: z.number(), evidenceUrls: z.array(z.string()) })),
  summary: z.string(),
});

export type SocialListeningInput = z.infer<typeof socialListeningInputSchema>;
export type SocialListeningOutput = z.infer<typeof socialListeningOutputSchema>;

function bump(
  map: Map<string, { label: string; frequency: number; evidenceUrls: Set<string> }>,
  label: string,
  url: string,
) {
  const key = label.trim().toLowerCase();
  if (!key) return;
  const existing = map.get(key);
  if (existing) {
    existing.frequency += 1;
    existing.evidenceUrls.add(url);
  } else {
    map.set(key, { label: label.trim(), frequency: 1, evidenceUrls: new Set([url]) });
  }
}

function toSorted(
  map: Map<string, { label: string; frequency: number; evidenceUrls: Set<string> }>,
) {
  return [...map.values()]
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 15)
    .map((v) => ({
      label: v.label,
      frequency: v.frequency,
      evidenceUrls: [...v.evidenceUrls].slice(0, 8),
    }));
}

/**
 * Social listening — high-engagement recent content, cheap-tier per-post extraction.
 */
export const socialListeningAgent: Agent<SocialListeningInput, SocialListeningOutput> = {
  name: "social_listening",
  description:
    "Finds recent high-engagement posts on a topic and extracts themes, hooks, formats, questions, and complaints.",
  inputSchema: socialListeningInputSchema,
  outputSchema: socialListeningOutputSchema,
  tier: "cheap",
  estimateCostCents: (input) => {
    const n = input.maxPosts ?? 15;
    // 1¢ expand + ~1¢ per post extraction on cheap tier.
    return Math.max(4, 1 + n);
  },
  userFacingLabel: (input) => {
    const topic = (input.topic || "your niche").trim().slice(0, 80);
    return `Listening for what’s getting attention around “${topic}”`;
  },
  async execute(input, ctx) {
    const parsed = socialListeningInputSchema.parse(input);
    const maxPosts = parsed.maxPosts ?? 15;
    await assertWithinSpendCap(ctx.organisationId, socialListeningAgent.estimateCostCents(parsed));

    const model = resolveModelForTier("cheap");
    let costCents = 0;

    const job = await prisma.researchJob.create({
      data: {
        organisationId: ctx.organisationId,
        agentRunId: ctx.agentRunId,
        kind: "SOCIAL_LISTENING",
        topic: parsed.topic,
        status: "RUNNING",
        queries: [parsed.topic],
        startedAt: new Date(),
      },
    });

    const platforms = listConfiguredSourcePlatforms();
    const started = Date.now();
    const { results, errors, billableCents } = await searchConfiguredSources({
      query: parsed.topic,
      platforms,
      concurrency: Number(getEnv().RESEARCH_ADAPTER_CONCURRENCY || 3),
      options: {
        organisationId: ctx.organisationId,
        limit: maxPosts,
        recent: true,
        nicheHint: parsed.nicheHint,
      },
    });
    costCents += billableCents;

    await recordResearchToolCall({
      organisationId: ctx.organisationId,
      agentStepId: ctx.agentStepId,
      toolName: "source.search",
      args: { query: parsed.topic, platforms, kind: "social_listening" },
      result: {
        count: results.length,
        urls: results.map((r) => r.url).slice(0, 40),
        errors: errors.map((e) => ({ platform: e.platform, code: e.code })),
        billableCents,
      },
      durationMs: Date.now() - started,
    });

    const ranked = rankSourceResults(dedupeSourceResults(results)).slice(0, maxPosts);

    const themes = new Map<string, { label: string; frequency: number; evidenceUrls: Set<string> }>();
    const hooks = new Map<string, { label: string; frequency: number; evidenceUrls: Set<string> }>();
    const formats = new Map<string, { label: string; frequency: number; evidenceUrls: Set<string> }>();
    const questions = new Map<string, { label: string; frequency: number; evidenceUrls: Set<string> }>();
    const complaints = new Map<string, { label: string; frequency: number; evidenceUrls: Set<string> }>();

    // CHEAP tier only — volume extraction must not use heavy/balanced.
    await mapPool(ranked, 3, async (post: SourceResult) => {
      await assertWithinSpendCap(ctx.organisationId, 1);
      const extract = await completeStructured(postExtractSchema, {
        organisationId: ctx.organisationId,
        tier: "cheap",
        model,
        system:
          "Extract recurring themes, hooks, formats, audience questions, and complaints from one post. Stay factual. Do not invent engagement stats. Domain-agnostic — never assume Instagram marketing.",
        prompt: `Topic: ${parsed.topic}\nURL: ${post.url}\nTitle: ${post.title}\nAuthor: ${post.author || "unknown"}\nContent:\n${post.content.slice(0, 4000)}`,
        temperature: 0.2,
      });
      costCents += 1;

      const persisted = await persistResearchSourceWithSnapshot({
        organisationId: ctx.organisationId,
        researchJobId: job.id,
        url: post.url,
        title: post.title,
        platform: post.platform,
        author: post.author,
        publishedAt: post.publishedAt,
        content: post.content,
        engagement: (post.engagement ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        rawMetadata: post.rawMetadata as Prisma.InputJsonValue,
        queryUsed: parsed.topic,
      });

      await prisma.socialPost.create({
        data: {
          organisationId: ctx.organisationId,
          researchJobId: job.id,
          researchSourceId: persisted.sourceId,
          platform: post.platform,
          url: post.url,
          title: post.title,
          author: post.author,
          publishedAt: post.publishedAt,
          content: post.content.slice(0, 20_000),
          engagement: (post.engagement ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          extractedThemes: extract.themes,
          extractedHooks: extract.hooks,
          extractedFormats: extract.formats,
          extractedQuestions: extract.questions,
          extractedComplaints: extract.complaints,
        },
      });

      for (const t of extract.themes) bump(themes, t, post.url);
      for (const h of extract.hooks) bump(hooks, h, post.url);
      for (const f of extract.formats) bump(formats, f, post.url);
      for (const q of extract.questions) bump(questions, q, post.url);
      for (const c of extract.complaints) bump(complaints, c, post.url);

      return null;
    });

    const themeList = toSorted(themes);
    const hookList = toSorted(hooks);
    const formatList = toSorted(formats);
    const questionList = toSorted(questions);
    const complaintList = toSorted(complaints);

    async function persistSignals(
      signalType: string,
      items: Array<{ label: string; frequency: number; evidenceUrls: string[] }>,
    ) {
      for (const item of items) {
        await prisma.trendSignal.create({
          data: {
            organisationId: ctx.organisationId,
            researchJobId: job.id,
            signalType,
            label: item.label,
            frequency: item.frequency,
            evidenceUrls: item.evidenceUrls,
          },
        });
      }
    }

    await persistSignals("theme", themeList);
    await persistSignals("hook", hookList);
    await persistSignals("format", formatList);
    await persistSignals("question", questionList);
    await persistSignals("complaint", complaintList);

    const unavailableNotes = formatUnavailableSourceNotes(errors);
    const baseSummary =
      ranked.length === 0
        ? "No recent high-engagement posts were returned from configured sources."
        : `Reviewed ${ranked.length} posts. Top themes: ${themeList
            .slice(0, 3)
            .map((t) => t.label)
            .join(", ") || "none yet"}.`;
    const summary = [baseSummary, ...unavailableNotes].join(" ").trim();

    const output: SocialListeningOutput = {
      researchJobId: job.id,
      topic: parsed.topic,
      postCount: ranked.length,
      themes: themeList,
      hooks: hookList,
      formats: formatList,
      questions: questionList,
      complaints: complaintList,
      summary,
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
          : "I couldn't find recent posts. Check that research source API keys are configured.",
      },
    });

    return { output, model, costCents };
  },
};
