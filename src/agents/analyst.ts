import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import { completeStructured } from "@/adapters/ai/structured";
import { resolveModelForTier } from "@/lib/ai-models";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { prisma } from "@/lib/db";

export const analystInputSchema = z.object({
  researchJobId: z.string().min(1),
  topic: z.string().min(1).max(2000).optional(),
});

const claimSchema = z.object({
  claim: z.string().min(1),
  sourceUrl: z.string().url(),
});

export const analystOutputSchema = z.object({
  researchJobId: z.string(),
  summary: z.string(),
  claims: z.array(claimSchema),
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
  summary: z.string().min(1).max(4000),
  claims: z.array(claimSchema).max(40),
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

/**
 * Analyst — synthesises a brief. Every claim maps to a source URL.
 * Contradictions and gaps are named explicitly.
 */
export const analystAgent: Agent<AnalystInput, AnalystOutput> = {
  name: "analyst",
  description:
    "Turns collected research sources into a brief where every claim cites a real source URL, and names contradictions and gaps.",
  inputSchema: analystInputSchema,
  outputSchema: analystOutputSchema,
  tier: "balanced",
  estimateCostCents: () => 4,
  userFacingLabel: (input) =>
    input.topic?.trim()
      ? `Writing a sourced brief on “${input.topic.trim().slice(0, 70)}”`
      : "Writing a sourced research brief",
  async execute(input, ctx) {
    const parsed = analystInputSchema.parse(input);
    await assertWithinSpendCap(ctx.organisationId, analystAgent.estimateCostCents(parsed));

    const job = await prisma.researchJob.findFirst({
      where: { id: parsed.researchJobId, organisationId: ctx.organisationId },
      include: {
        sources: {
          where: { organisationId: ctx.organisationId },
          orderBy: { createdAt: "asc" },
          take: 40,
        },
        findings: {
          where: { organisationId: ctx.organisationId },
          take: 40,
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
        summary: "There are no collected sources to analyse yet.",
        claims: [],
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
      .map(
        (s) =>
          `URL: ${s.url}\nTitle: ${s.title || ""}\nPlatform: ${s.platform}\nExcerpt:\n${(s.content || "").slice(0, 1500)}`,
      )
      .join("\n\n----\n\n");

    const priorFindings = job.findings
      .map((f) => {
        const src = job.sources.find((s) => s.id === f.researchSourceId);
        return `- ${f.claim} (${src?.url || "missing-url"})`;
      })
      .join("\n");

    const model = resolveModelForTier("balanced");
    const brief = await completeStructured(briefSchema, {
      organisationId: ctx.organisationId,
      tier: "balanced",
      model,
      system: `You are an analyst writing a short business research brief.
Rules:
- Every claim MUST include a sourceUrl that exactly matches one provided URL.
- Never invent statistics, quotes, or URLs.
- Name contradictions between sources explicitly — do not smooth them over.
- Name gaps (what the sources do not cover) explicitly.
- Stay domain-agnostic; do not assume Instagram marketing.`,
      prompt: `Topic: ${parsed.topic || job.topic}

Prior findings:
${priorFindings || "(none)"}

Sources:
${catalog.slice(0, 70_000)}`,
      temperature: 0.2,
    });

    const claims = brief.claims.filter((c) => allowedUrls.has(c.sourceUrl));
    const contradictions = brief.contradictions
      .map((c) => ({
        description: c.description,
        sourceUrls: c.sourceUrls.filter((u) => allowedUrls.has(u)),
      }))
      .filter((c) => c.sourceUrls.length > 0);

    const output: AnalystOutput = {
      researchJobId: job.id,
      summary: brief.summary,
      claims,
      contradictions,
      gaps: brief.gaps,
    };

    await prisma.researchJob.updateMany({
      where: { id: job.id, organisationId: ctx.organisationId },
      data: {
        brief: output as unknown as Prisma.InputJsonValue,
        contradictions: contradictions as unknown as Prisma.InputJsonValue,
        gaps: brief.gaps as unknown as Prisma.InputJsonValue,
        totalCostCents: { increment: 4 },
      },
    });

    return { output, model, costCents: 4 };
  },
};
