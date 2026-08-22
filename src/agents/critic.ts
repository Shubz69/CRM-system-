import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Agent } from "@/agents/types";
import { assertWithinSpendCap } from "@/services/ai-spend-gate";
import { prisma } from "@/lib/db";
import { isExcerptGrounded } from "@/services/research-evidence";

export const criticInputSchema = z.object({
  researchJobId: z.string().min(1),
  /** Optional inline brief when chaining without a DB round-trip of claims. */
  claims: z
    .array(
      z.object({
        claim: z.string(),
        sourceUrl: z.string().url(),
        evidenceExcerpt: z.string().optional(),
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
      grounded: z.boolean().optional(),
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
  ungroundedClaims: z.array(
    z.object({
      claim: z.string(),
      sourceUrl: z.string(),
      reason: z.string(),
    }),
  ),
  allCitationsValid: z.boolean(),
  allClaimsGrounded: z.boolean(),
});

export type CriticInput = z.infer<typeof criticInputSchema>;
export type CriticOutput = z.infer<typeof criticOutputSchema>;

/**
 * Critic — verifies citation URLs exist in collected sources AND that
 * evidence excerpts / claim tokens are grounded in source content.
 */
export const criticAgent: Agent<CriticInput, CriticOutput> = {
  name: "critic",
  description:
    "Checks that every claim cites a collected URL and that evidence is grounded in source content. Flags unsupported or ungrounded claims.",
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
          select: { id: true, url: true, content: true },
        },
        findings: {
          where: { organisationId: ctx.organisationId },
          include: { source: { select: { url: true, content: true } } },
        },
      },
    });
    if (!job) {
      throw new Error("Research job not found for this organisation");
    }

    const collectedUrls = new Set(job.sources.map((s) => s.url));
    const contentByUrl = new Map(job.sources.map((s) => [s.url, s.content]));

    type Claim = { claim: string; sourceUrl: string; evidenceExcerpt?: string };
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
        evidenceExcerpt: f.evidenceExcerpt ?? undefined,
      }));
    }

    const verifiedClaims: CriticOutput["verifiedClaims"] = [];
    const unsupportedClaims: CriticOutput["unsupportedClaims"] = [];
    const ungroundedClaims: CriticOutput["ungroundedClaims"] = [];

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
          grounded: false,
          reason: "missing or unknown source URL",
        });
        continue;
      }

      const grounding = isExcerptGrounded({
        claim: claim.claim,
        evidenceExcerpt: claim.evidenceExcerpt,
        sourceContent: contentByUrl.get(claim.sourceUrl) ?? null,
      });

      if (!grounding.grounded) {
        ungroundedClaims.push({
          claim: claim.claim,
          sourceUrl: claim.sourceUrl,
          reason: grounding.reason,
        });
        verifiedClaims.push({
          claim: claim.claim,
          sourceUrl: claim.sourceUrl,
          ok: true,
          grounded: false,
          reason: grounding.reason,
        });
        continue;
      }

      verifiedClaims.push({
        claim: claim.claim,
        sourceUrl: claim.sourceUrl,
        ok: true,
        grounded: true,
        reason: grounding.reason,
      });
    }

    for (const finding of job.findings) {
      const url = finding.source.url;
      const urlOk = collectedUrls.has(url);
      const grounding = isExcerptGrounded({
        claim: finding.claim,
        evidenceExcerpt: finding.evidenceExcerpt,
        sourceContent: finding.source.content,
      });
      await prisma.researchFinding.updateMany({
        where: {
          id: finding.id,
          organisationId: ctx.organisationId,
          researchJobId: job.id,
        },
        data: {
          verifiedByCritic: urlOk && grounding.grounded,
          flaggedUnsupported: !urlOk,
          flaggedUngrounded: urlOk && !grounding.grounded && !grounding.skipped,
        },
      });
    }

    const issues: string[] = [];
    if (unsupportedClaims.length) {
      issues.push(
        `${unsupportedClaims.length} claim${unsupportedClaims.length === 1 ? "" : "s"} lacked a collected source URL`,
      );
    }
    if (ungroundedClaims.length) {
      issues.push(
        `${ungroundedClaims.length} claim${ungroundedClaims.length === 1 ? "" : "s"} were not grounded in source content`,
      );
    }

    const output: CriticOutput = {
      researchJobId: job.id,
      summary:
        issues.length === 0
          ? claims.length
            ? `All ${claims.length} claims cite collected sources and are grounded in source content.`
            : parsed.summary?.trim()
              ? `${parsed.summary.trim()}\n\n(No citeable claims were available to verify against collected URLs.)`
              : "Research finished, but no citeable claims were produced from the sources."
          : `${issues.join("; ")}.`,
      verifiedClaims,
      unsupportedClaims,
      ungroundedClaims,
      allCitationsValid: unsupportedClaims.length === 0 || claims.length === 0,
      allClaimsGrounded:
        (unsupportedClaims.length === 0 && ungroundedClaims.length === 0) || claims.length === 0,
    };

    await prisma.researchJob.updateMany({
      where: { id: job.id, organisationId: ctx.organisationId },
      data: {
        criticReport: output as unknown as Prisma.InputJsonValue,
        status: output.allCitationsValid && output.allClaimsGrounded ? job.status : "PARTIAL",
      },
    });

    return { output, costCents: 0 };
  },
};
