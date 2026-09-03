import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import { completeStructuredSafe } from "@/adapters/ai/structured";
import { resolveModelForTier } from "@/lib/ai-models";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export const analystInputSchema = z.object({
  researchJobId: z.string().min(1),
  topic: z.string().min(1).max(2000).optional(),
});

const claimSchema = z.object({
  claim: z.string().min(1),
  sourceUrl: z
    .string()
    .min(1)
    .transform((raw) => {
      const trimmed = raw.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(trimmed)) return `https://${trimmed}`;
      return trimmed;
    })
    .pipe(z.string().url()),
  evidenceExcerpt: z.string().max(800).optional(),
  claimKind: z
    .enum(["OFFICIAL", "OBSERVATION", "INFERENCE", "SECONDARY", "UNKNOWN"])
    .optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const viralExampleSchema = z.object({
  title: z.string().min(1).max(200),
  whyItWorked: z.string().min(1).max(500),
  platform: z.string().min(1).max(40),
  sourceUrl: z
    .string()
    .min(1)
    .transform((raw) => {
      const trimmed = raw.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(trimmed)) return `https://${trimmed}`;
      return trimmed;
    })
    .pipe(z.string().url()),
  formatHint: z.string().max(120).optional(),
});

const nextBigThingSchema = z.object({
  prediction: z.string().min(1).max(400),
  whyNow: z.string().min(1).max(500),
  howToRideIt: z.string().min(1).max(500),
  confidence: z.enum(["low", "medium", "high"]).optional(),
});

export const analystOutputSchema = z.object({
  researchJobId: z.string(),
  /** Ultra-short takeaways for a busy creator (bullet-style text). */
  shortAnswer: z.string(),
  /** Longer narrative brief. */
  summary: z.string(),
  brief: z.string().optional(),
  claims: z.array(claimSchema),
  viralExamples: z.array(viralExampleSchema).optional(),
  nextBigThings: z.array(nextBigThingSchema).optional(),
  contentHooks: z.array(z.string()).optional(),
  algorithmNotes: z.array(z.string()).optional(),
  contradictions: z.array(
    z.object({
      description: z.string(),
      sourceUrls: z.array(z.string().url()).min(1),
    }),
  ),
  gaps: z.array(z.string()),
});

export type AnalystInput = z.infer<typeof analystInputSchema>;
export type AnalystOutput = z.infer<typeof analystOutputSchema>;

const briefSchema = z.object({
  shortAnswer: z.string().min(1).max(1200),
  summary: z.string().min(1).max(2500),
  brief: z.string().min(1).max(8000),
  claims: z.array(claimSchema).max(40),
  viralExamples: z.array(viralExampleSchema).max(12),
  nextBigThings: z.array(nextBigThingSchema).max(6),
  contentHooks: z.array(z.string().min(1).max(280)).max(12),
  algorithmNotes: z.array(z.string().min(1).max(400)).max(10),
  contradictions: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        sourceUrls: z.array(z.string().url()).min(1).max(6),
      }),
    )
    .max(20),
  gaps: z.array(z.string().max(400)).max(20),
});

function looksLikeVideoUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|tiktok\.com|instagram\.com\/(reel|p|tv)|shorts/i.test(url);
}

/**
 * Analyst — synthesises a creator-ready pack: short answer, full brief,
 * viral examples with real links, and algorithm “what’s next” takes.
 * Every claim / viral example URL must come from collected sources.
 */
export const analystAgent: Agent<AnalystInput, AnalystOutput> = {
  name: "analyst",
  description:
    "Turns collected research into a social-ready pack: short answer, full brief, viral examples with links, content hooks, and algorithm next-big-thing takes — every citation from real sources.",
  inputSchema: analystInputSchema,
  outputSchema: analystOutputSchema,
  tier: "balanced",
  estimateCostCents: () => 6,
  userFacingLabel: (input) =>
    input.topic?.trim()
      ? `Packaging viral intel on “${input.topic.trim().slice(0, 70)}”`
      : "Packaging a sourced social brief",
  async execute(input, ctx) {
    const parsed = analystInputSchema.parse(input);
    await assertWithinSpendCap(ctx.organisationId, analystAgent.estimateCostCents(parsed));

    const job = await prisma.researchJob.findFirst({
      where: { id: parsed.researchJobId, organisationId: ctx.organisationId },
      include: {
        sources: {
          where: { organisationId: ctx.organisationId },
          orderBy: { createdAt: "asc" },
          take: 50,
        },
        findings: {
          where: { organisationId: ctx.organisationId },
          take: 50,
        },
      },
    });
    if (!job) {
      throw new Error("Research job not found for this organisation");
    }

    const allowedUrls = new Set(job.sources.map((s) => s.url));
    if (!allowedUrls.size) {
      const empty: AnalystOutput = {
        researchJobId: job.id,
        shortAnswer: "No sources came back yet — check research integrations and try again.",
        summary: "There are no collected sources to analyse yet.",
        brief: "There are no collected sources to analyse yet.",
        claims: [],
        viralExamples: [],
        nextBigThings: [],
        contentHooks: [],
        algorithmNotes: [],
        contradictions: [],
        gaps: ["No sources were collected for this job."],
      };
      await prisma.researchJob.updateMany({
        where: { id: job.id, organisationId: ctx.organisationId },
        data: {
          brief: empty as unknown as Prisma.InputJsonValue,
          gaps: empty.gaps as unknown as Prisma.InputJsonValue,
        },
      });
      return { output: empty, costCents: 0 };
    }

    const catalog = job.sources
      .map((s) => {
        const video = looksLikeVideoUrl(s.url) ? " VIDEO" : "";
        return `URL: ${s.url}\nTitle: ${s.title || ""}\nPlatform: ${s.platform}${video}\nExcerpt:\n${(s.content || "").slice(0, 1500)}`;
      })
      .join("\n\n----\n\n");

    const priorFindings = job.findings
      .map((f) => {
        const src = job.sources.find((s) => s.id === f.researchSourceId);
        return `- ${f.claim} (${src?.url || "missing-url"})`;
      })
      .join("\n");

    const model = resolveModelForTier("balanced");
    const briefResult = await completeStructuredSafe(briefSchema, {
      organisationId: ctx.organisationId,
      tier: "balanced",
      model,
      system: `You are a social-media intelligence analyst for creators and agencies.
Your job is NOT a thin one-paragraph brief. Produce a full pack creators can act on today.

Required output:
1) shortAnswer — 4–8 punchy bullet lines (use "- " prefixes) with the most recent themes, complaints, and opportunities.
2) summary — 1 short paragraph executive take.
3) brief — a longer structured write-up (themes, what people are saying, what’s working on-feed, what to post next). Aim for substance (multiple short sections).
4) claims — factual claims, each with a sourceUrl that EXACTLY matches a provided URL, plus evidenceExcerpt copied from that source when possible, optional claimKind (OFFICIAL|OBSERVATION|INFERENCE|SECONDARY).
5) viralExamples — the most recent / high-signal posts or videos from the sources (prefer YouTube/TikTok/Instagram/Reel/Shorts URLs). Each needs title, whyItWorked, platform, sourceUrl from the list, optional formatHint.
6) nextBigThings — 2–5 predictions of what the algorithm is likely to reward next in this niche. Label confidence. Base reasoning on patterns in the sources; do NOT invent URLs.
7) contentHooks — 5–10 ready-to-post hook lines.
8) algorithmNotes — practical notes on formats, hooks, length, posting patterns that appear to be winning.
9) contradictions + gaps — be honest about what sources disagree on or don’t cover.

Hard rules:
- Never invent statistics, quotes, or URLs.
- Every claim.sourceUrl and viralExamples.sourceUrl MUST exactly match a provided URL.
- Prefer the freshest / most engagement-looking items when ranking viralExamples.
- If few video URLs exist, still fill viralExamples from the best available posts and say so in gaps.
- If organisation knowledge is provided, use it only to tailor relevance to this business — never invent URLs or treat internal docs as public citations.`,
      prompt: `Topic: ${parsed.topic || job.topic}

${ctx.knowledgeContext?.trim() ? `Organisation knowledge:\n${ctx.knowledgeContext.slice(0, 4000)}\n\n` : ""}Prior findings:
${priorFindings || "(none)"}

Sources (use only these URLs):
${catalog.slice(0, 70_000)}`,
      temperature: 0.35,
    });

    const brief = briefResult.ok
      ? briefResult.data
      : (() => {
          logger.warn("Analyst brief degraded to findings fallback", {
            researchJobId: job.id,
            organisationId: ctx.organisationId,
            reason: briefResult.reason,
          });
          const fallbackClaims = job.findings
            .map((f) => {
              const src = job.sources.find((s) => s.id === f.researchSourceId);
              if (!src?.url || !allowedUrls.has(src.url)) return null;
              return {
                claim: f.claim,
                sourceUrl: src.url,
                evidenceExcerpt: f.evidenceExcerpt ?? undefined,
                claimKind: undefined as undefined,
                confidence: f.confidence ?? undefined,
              };
            })
            .filter((c): c is NonNullable<typeof c> => c != null)
            .slice(0, 20);
          const sourceTitles = job.sources
            .slice(0, 5)
            .map((s) => s.title || s.url)
            .filter(Boolean);
          return {
            shortAnswer:
              fallbackClaims.length > 0
                ? fallbackClaims
                    .slice(0, 6)
                    .map((c) => `- ${c.claim}`)
                    .join("\n")
                : `- Collected ${job.sources.length} sources on “${parsed.topic || job.topic}”.\n- Structured synthesis was unavailable; review sources below.`,
            summary:
              fallbackClaims.length > 0
                ? `Sourced overview of “${parsed.topic || job.topic}” from ${job.sources.length} collected sources.`
                : `Gathered ${job.sources.length} sources on “${parsed.topic || job.topic}” but could not complete a full structured brief.`,
            brief:
              fallbackClaims.length > 0
                ? `## Findings\n${fallbackClaims.map((c) => `- ${c.claim} (${c.sourceUrl})`).join("\n")}\n\n## Sources\n${sourceTitles.map((t) => `- ${t}`).join("\n")}`
                : `## Sources collected\n${sourceTitles.map((t) => `- ${t}`).join("\n") || "(none)"}`,
            claims: fallbackClaims,
            viralExamples: [] as z.infer<typeof viralExampleSchema>[],
            nextBigThings: [] as z.infer<typeof nextBigThingSchema>[],
            contentHooks: [] as string[],
            algorithmNotes: [] as string[],
            contradictions: [] as Array<{ description: string; sourceUrls: string[] }>,
            gaps: [
              "Structured analyst synthesis failed validation; showing grounded findings/sources only.",
              ...(briefResult.ok ? [] : ["Retry the Ask for a fuller brief if needed."]),
            ],
          };
        })();

    const claims = brief.claims.filter((c) => allowedUrls.has(c.sourceUrl));
    const viralExamples = (brief.viralExamples || []).filter((v) => allowedUrls.has(v.sourceUrl));
    const contradictions = (brief.contradictions || [])
      .map((c) => ({
        description: c.description,
        sourceUrls: c.sourceUrls.filter((u) => allowedUrls.has(u)),
      }))
      .filter((c) => c.sourceUrls.length > 0);

    const output: AnalystOutput = {
      researchJobId: job.id,
      shortAnswer: brief.shortAnswer,
      summary: brief.summary,
      brief: brief.brief,
      claims,
      viralExamples,
      nextBigThings: brief.nextBigThings || [],
      contentHooks: brief.contentHooks || [],
      algorithmNotes: brief.algorithmNotes || [],
      contradictions,
      gaps: brief.gaps || [],
    };

    await prisma.researchJob.updateMany({
      where: { id: job.id, organisationId: ctx.organisationId },
      data: {
        brief: output as unknown as Prisma.InputJsonValue,
        contradictions: contradictions as unknown as Prisma.InputJsonValue,
        gaps: brief.gaps as unknown as Prisma.InputJsonValue,
        totalCostCents: { increment: 6 },
      },
    });

    return { output, model, costCents: 6 };
  },
};
