/**
 * Phase 6 Content Operating System.
 * Every recommendation must carry whyEvidence. Publishing never fakes success.
 */

import {
  ContentOpportunityStatus,
  ContentPieceStatus,
  Prisma,
  PublishingJobStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureBuiltinToolsRegistered, evaluateToolPolicy } from "@/kernel";

export type WhyEvidence = {
  rationale: string;
  sourceUrls?: string[];
  researchJobId?: string | null;
  trendClusterId?: string | null;
  agentRunId?: string | null;
  claimSummaries?: string[];
};

export function assertWhyEvidence(evidence: WhyEvidence | null | undefined): WhyEvidence {
  const rationale = evidence?.rationale?.trim();
  if (!rationale) {
    throw new Error("Content recommendations require whyEvidence.rationale");
  }
  const urls = (evidence?.sourceUrls ?? []).filter((u) => typeof u === "string" && u.startsWith("http"));
  const hasLink =
    urls.length > 0 ||
    Boolean(evidence?.researchJobId) ||
    Boolean(evidence?.trendClusterId) ||
    Boolean(evidence?.agentRunId);
  if (!hasLink) {
    throw new Error(
      "whyEvidence must link to researchJobId, trendClusterId, agentRunId, or at least one sourceUrl",
    );
  }
  return {
    rationale,
    sourceUrls: urls,
    researchJobId: evidence?.researchJobId ?? null,
    trendClusterId: evidence?.trendClusterId ?? null,
    agentRunId: evidence?.agentRunId ?? null,
    claimSummaries: evidence?.claimSummaries ?? [],
  };
}

export async function createOpportunityFromResearch(input: {
  organisationId: string;
  researchJobId: string;
  agentRunId?: string | null;
  title?: string;
  platforms?: string[];
}): Promise<string> {
  const job = await prisma.researchJob.findFirst({
    where: { id: input.researchJobId, organisationId: input.organisationId },
    include: {
      findings: { take: 8, include: { source: { select: { url: true } } } },
      sources: { take: 10, select: { url: true, platform: true } },
    },
  });
  if (!job) throw new Error("Research job not found");

  const sourceUrls = [
    ...new Set([
      ...job.sources.map((s) => s.url),
      ...job.findings.map((f) => f.source.url),
    ]),
  ].slice(0, 15);

  const why = assertWhyEvidence({
    rationale: `Based on research job “${job.topic.slice(0, 120)}” with ${job.findings.length} grounded findings.`,
    researchJobId: job.id,
    agentRunId: input.agentRunId ?? job.agentRunId,
    sourceUrls,
    claimSummaries: job.findings.map((f) => f.claim).slice(0, 5),
  });

  const platforms =
    input.platforms?.length
      ? input.platforms
      : [...new Set(job.sources.map((s) => s.platform))].slice(0, 6);

  const row = await prisma.contentOpportunity.create({
    data: {
      organisationId: input.organisationId,
      title: input.title?.trim() || `Content from: ${job.topic.slice(0, 80)}`,
      summary: typeof job.brief === "object" && job.brief && "summary" in (job.brief as object)
        ? String((job.brief as { summary?: unknown }).summary ?? "").slice(0, 2000) || null
        : null,
      platforms,
      whyEvidence: why as unknown as Prisma.InputJsonValue,
      researchJobId: job.id,
      agentRunId: input.agentRunId ?? job.agentRunId,
      status: ContentOpportunityStatus.OPEN,
    },
  });
  return row.id;
}

export async function createIdeaFromOpportunity(input: {
  organisationId: string;
  opportunityId: string;
  title: string;
  angle?: string;
  hook?: string;
  formatHint?: string;
}): Promise<string> {
  const opp = await prisma.contentOpportunity.findFirst({
    where: { id: input.opportunityId, organisationId: input.organisationId },
  });
  if (!opp) throw new Error("Opportunity not found");

  const why = assertWhyEvidence(opp.whyEvidence as WhyEvidence);
  const row = await prisma.contentIdea.create({
    data: {
      organisationId: input.organisationId,
      opportunityId: opp.id,
      title: input.title.trim(),
      angle: input.angle ?? null,
      hook: input.hook ?? null,
      formatHint: input.formatHint ?? null,
      whyEvidence: why as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.contentOpportunity.updateMany({
    where: { id: opp.id, organisationId: input.organisationId },
    data: { status: ContentOpportunityStatus.ACCEPTED },
  });

  return row.id;
}

export async function createBriefAndPiece(input: {
  organisationId: string;
  ideaId: string;
  objective?: string;
  audience?: string;
  keyMessage?: string;
  cta?: string;
  pieceTitle: string;
  pieceBody: string;
  platform?: string;
}): Promise<{ briefId: string; pieceId: string }> {
  const idea = await prisma.contentIdea.findFirst({
    where: { id: input.ideaId, organisationId: input.organisationId },
  });
  if (!idea) throw new Error("Idea not found");
  const why = assertWhyEvidence(idea.whyEvidence as WhyEvidence);

  const brief = await prisma.creativeBrief.create({
    data: {
      organisationId: input.organisationId,
      ideaId: idea.id,
      objective: input.objective ?? null,
      audience: input.audience ?? null,
      keyMessage: input.keyMessage ?? null,
      cta: input.cta ?? null,
      whyEvidence: why as unknown as Prisma.InputJsonValue,
    },
  });

  const piece = await prisma.contentPiece.create({
    data: {
      organisationId: input.organisationId,
      briefId: brief.id,
      title: input.pieceTitle.trim(),
      body: input.pieceBody,
      platform: input.platform ?? null,
      status: ContentPieceStatus.DRAFT,
      whyEvidence: why as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.contentVersion.create({
    data: {
      organisationId: input.organisationId,
      pieceId: piece.id,
      version: 1,
      title: piece.title,
      body: piece.body,
    },
  });

  return { briefId: brief.id, pieceId: piece.id };
}

export async function submitPieceForApproval(input: {
  organisationId: string;
  pieceId: string;
}): Promise<string> {
  const piece = await prisma.contentPiece.findFirst({
    where: { id: input.pieceId, organisationId: input.organisationId },
  });
  if (!piece) throw new Error("Piece not found");
  assertWhyEvidence(piece.whyEvidence as WhyEvidence);

  await prisma.contentPiece.updateMany({
    where: { id: piece.id, organisationId: input.organisationId },
    data: { status: ContentPieceStatus.IN_REVIEW },
  });

  const approval = await prisma.contentApproval.create({
    data: {
      organisationId: input.organisationId,
      pieceId: piece.id,
      decision: "PENDING",
    },
  });
  return approval.id;
}

export async function decidePieceApproval(input: {
  organisationId: string;
  pieceId: string;
  decision: "APPROVED" | "REJECTED";
  decidedByUserId?: string | null;
  note?: string | null;
}): Promise<void> {
  const piece = await prisma.contentPiece.findFirst({
    where: { id: input.pieceId, organisationId: input.organisationId },
  });
  if (!piece) throw new Error("Piece not found");

  await prisma.contentApproval.create({
    data: {
      organisationId: input.organisationId,
      pieceId: piece.id,
      decision: input.decision,
      decidedByUserId: input.decidedByUserId ?? null,
      note: input.note ?? null,
      decidedAt: new Date(),
    },
  });

  await prisma.contentPiece.updateMany({
    where: { id: piece.id, organisationId: input.organisationId },
    data: {
      status:
        input.decision === "APPROVED"
          ? ContentPieceStatus.APPROVED
          : ContentPieceStatus.DRAFT,
    },
  });
}

/**
 * Request publish via Kernel policy. Never marks PUBLISHED without a real external id.
 */
export async function requestPublish(input: {
  organisationId: string;
  pieceId: string;
  platform: string;
  variantId?: string | null;
  socialConnectionId?: string | null;
  scheduledAt?: Date | null;
}): Promise<{ jobId: string; status: PublishingJobStatus; policyEffect: string }> {
  ensureBuiltinToolsRegistered();
  const piece = await prisma.contentPiece.findFirst({
    where: { id: input.pieceId, organisationId: input.organisationId },
  });
  if (!piece) throw new Error("Piece not found");
  if (piece.status !== ContentPieceStatus.APPROVED && piece.status !== ContentPieceStatus.SCHEDULED) {
    throw new Error("Only approved (or scheduled) pieces can be queued for publish");
  }
  assertWhyEvidence(piece.whyEvidence as WhyEvidence);

  const policy = evaluateToolPolicy("social.publish", {
    organisationId: input.organisationId,
  });
  if (policy.effect === "deny") {
    throw new Error(policy.reason || "Publishing is disabled by policy");
  }

  const status =
    policy.effect === "require_approval"
      ? PublishingJobStatus.PENDING_APPROVAL
      : PublishingJobStatus.APPROVED;

  const job = await prisma.publishingJob.create({
    data: {
      organisationId: input.organisationId,
      pieceId: piece.id,
      variantId: input.variantId ?? null,
      platform: input.platform,
      status,
      socialConnectionId: input.socialConnectionId ?? null,
      scheduledAt: input.scheduledAt ?? null,
      policySnapshot: {
        effect: policy.effect,
        reason: policy.reason,
        toolName: "social.publish",
      } as Prisma.InputJsonValue,
    },
  });

  if (input.scheduledAt && status === PublishingJobStatus.APPROVED) {
    await prisma.contentPiece.updateMany({
      where: { id: piece.id, organisationId: input.organisationId },
      data: { status: ContentPieceStatus.SCHEDULED },
    });
  }

  return { jobId: job.id, status, policyEffect: policy.effect };
}

/**
 * Record a real publish result only. Requires externalPostId or externalUrl from the platform API.
 */
export async function recordPublishResult(input: {
  organisationId: string;
  jobId: string;
  externalPostId?: string | null;
  externalUrl?: string | null;
  error?: string | null;
}): Promise<void> {
  const job = await prisma.publishingJob.findFirst({
    where: { id: input.jobId, organisationId: input.organisationId },
  });
  if (!job) throw new Error("Publishing job not found");

  if (input.error) {
    await prisma.publishingJob.updateMany({
      where: { id: job.id, organisationId: input.organisationId },
      data: {
        status: PublishingJobStatus.FAILED,
        error: input.error,
      },
    });
    await prisma.contentPiece.updateMany({
      where: { id: job.pieceId, organisationId: input.organisationId },
      data: { status: ContentPieceStatus.FAILED },
    });
    return;
  }

  if (!input.externalPostId?.trim() && !input.externalUrl?.trim()) {
    throw new Error("Cannot mark published without externalPostId or externalUrl from the platform");
  }

  await prisma.publishingJob.updateMany({
    where: { id: job.id, organisationId: input.organisationId },
    data: {
      status: PublishingJobStatus.PUBLISHED,
      publishedAt: new Date(),
      externalPostId: input.externalPostId ?? null,
      externalUrl: input.externalUrl ?? null,
      error: null,
    },
  });
  await prisma.contentPiece.updateMany({
    where: { id: job.pieceId, organisationId: input.organisationId },
    data: { status: ContentPieceStatus.PUBLISHED },
  });
}

export async function recordPostPerformance(input: {
  organisationId: string;
  pieceId?: string | null;
  publishingJobId?: string | null;
  socialContentId?: string | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  clicks?: number | null;
  leadsAttributed?: number | null;
  raw?: Record<string, unknown>;
}): Promise<string> {
  const row = await prisma.postPerformance.create({
    data: {
      organisationId: input.organisationId,
      pieceId: input.pieceId ?? null,
      publishingJobId: input.publishingJobId ?? null,
      socialContentId: input.socialContentId ?? null,
      views: input.views ?? null,
      likes: input.likes ?? null,
      comments: input.comments ?? null,
      shares: input.shares ?? null,
      clicks: input.clicks ?? null,
      leadsAttributed: input.leadsAttributed ?? null,
      raw: (input.raw ?? {}) as Prisma.InputJsonValue,
    },
  });
  return row.id;
}
