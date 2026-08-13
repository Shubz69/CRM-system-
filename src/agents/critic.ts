import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { prisma } from "@/lib/db";

export const criticInputSchema = z.object({
  researchJobId: z.string().min(1),
  /** Optional inline brief when chaining without a DB round-trip of claims. */
  claims: z
    .array(
      z.object({
        claim: z.string(),
        sourceUrl: z.string().url(),
      }),
    )
    .optional(),
  summary: z.string().optional(),
  contradictions: z
    .array(
      z.object({
        description: z.string(),
        sourceUrls: z.array(z.string().url()),
      }),
    )
    .optional(),
  gaps: z.array(z.string()).optional(),
});

export const criticOutputSchema = z.object({
  researchJobId: z.string(),
  summary: z.string(),
  verifiedClaims: z.array(
    z.object({
      claim: z.string(),
      sourceUrl: z.string(),
      ok: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  unsupportedClaims: z.array(
    z.object({
      claim: z.string(),
      sourceUrl: z.string().optional(),
      reason: z.string(),
    }),
  ),
  allCitationsValid: z.boolean(),
});

export type CriticInput = z.infer<typeof criticInputSchema>;
export type CriticOutput = z.infer<typeof criticOutputSchema>;

/**
 * Critic — verifies every citation URL appears in collected sources.
 * Flags unsupported claims. Guard against invented statistics. Not optional.
 */
export const criticAgent: Agent<CriticInput, CriticOutput> = {
  name: "critic",
  description:
    "Checks that every claim in a research brief cites a URL that was actually collected. Flags unsupported claims.",
  inputSchema: criticInputSchema,
  outputSchema: criticOutputSchema,
  tier: "cheap",
  estimateCostCents: () => 0,
  userFacingLabel: () => "Checking every claim against the collected sources",
  async execute(input, ctx) {
    const parsed = criticInputSchema.parse(input);
    await assertWithinSpendCap(ctx.organisationId, 0);

    const job = await prisma.researchJob.findFirst({
      where: { id: parsed.researchJobId, organisationId: ctx.organisationId },
      include: {
        sources: {
          where: { organisationId: ctx.organisationId },
          select: { id: true, url: true },
        },
        findings: {
          where: { organisationId: ctx.organisationId },
          include: { source: { select: { url: true } } },
        },
      },
    });
    if (!job) {
      throw new Error("Research job not found for this organisation");
    }

    const collectedUrls = new Set(job.sources.map((s) => s.url));

    type Claim = { claim: string; sourceUrl: string };
    let claims: Claim[] = parsed.claims ?? [];

    if (!claims.length && job.brief && typeof job.brief === "object") {
      const brief = job.brief as { claims?: Claim[] };
      if (Array.isArray(brief.claims)) {
        claims = brief.claims.filter(
          (c) => typeof c?.claim === "string" && typeof c?.sourceUrl === "string",
        );
      }
    }

    if (!claims.length) {
      claims = job.findings.map((f) => ({
        claim: f.claim,
        sourceUrl: f.source.url,
      }));
    }

    const verifiedClaims: CriticOutput["verifiedClaims"] = [];
    const unsupportedClaims: CriticOutput["unsupportedClaims"] = [];

    for (const claim of claims) {
      if (!claim.sourceUrl || !collectedUrls.has(claim.sourceUrl)) {
        unsupportedClaims.push({
          claim: claim.claim,
          sourceUrl: claim.sourceUrl || undefined,
          reason: claim.sourceUrl
            ? "Citation URL was not in the collected sources for this job"
            : "Claim has no source URL",
        });
        verifiedClaims.push({
          claim: claim.claim,
          sourceUrl: claim.sourceUrl || "",
          ok: false,
          reason: "missing or unknown source URL",
        });
        continue;
      }
      verifiedClaims.push({
        claim: claim.claim,
        sourceUrl: claim.sourceUrl,
        ok: true,
      });
    }

    // Mark DB findings
    for (const finding of job.findings) {
      const url = finding.source.url;
      const ok = collectedUrls.has(url);
      await prisma.researchFinding.updateMany({
        where: {
          id: finding.id,
          organisationId: ctx.organisationId,
          researchJobId: job.id,
        },
        data: {
          verifiedByCritic: ok,
          flaggedUnsupported: !ok,
        },
      });
    }

    const output: CriticOutput = {
      researchJobId: job.id,
      summary:
        unsupportedClaims.length === 0
          ? claims.length
            ? `All ${claims.length} claims cite sources we actually collected.`
            : "No claims to verify yet."
          : `${unsupportedClaims.length} claim${unsupportedClaims.length === 1 ? "" : "s"} lacked a collected source URL.`,
      verifiedClaims,
      unsupportedClaims,
      allCitationsValid: unsupportedClaims.length === 0,
    };

    await prisma.researchJob.updateMany({
      where: { id: job.id, organisationId: ctx.organisationId },
      data: {
        criticReport: output as unknown as Prisma.InputJsonValue,
        status: output.allCitationsValid ? job.status : "PARTIAL",
      },
    });

    return { output, costCents: 0 };
  },
};
