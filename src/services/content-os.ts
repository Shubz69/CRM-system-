/**
 * Phase 6 Content Operating System.
 * Every recommendation must carry whyEvidence. Publishing never fakes success.
 * Phase 15 — externalOutcome ledger on PublishingJob (CONFIRMED / FAILED / RECONCILIATION_REQUIRED).
 */

import {
  ApprovalRequestStatus,
  ContentOpportunityStatus,
  ContentPieceStatus,
  MissionExternalOutcome,
  Prisma,
  PublishingJobStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureBuiltinToolsRegistered, evaluateToolPolicy } from "@/kernel";
import { appendDomainEvent } from "@/services/domain-events/append";
import {
  buildPublishIdempotencyKey,
  formatPublishActionDescription,
} from "@/services/publishing/platform";

export type WhyEvidence = {
  rationale: string;
  sourceUrls?: string[];
  researchJobId?: string | null;
  trendClusterId?: string | null;
  agentRunId?: string | null;
  claimSummaries?: string[];
  /** Operator-created draft without research linkage. */
  operatorDraft?: boolean;
};

export function assertWhyEvidence(evidence: WhyEvidence | null | undefined): WhyEvidence {
  const rationale = evidence?.rationale?.trim();
  if (!rationale) {
    throw new Error("Content recommendations require a short rationale.");
  }
  const urls = (evidence?.sourceUrls ?? []).filter((u) => typeof u === "string" && u.startsWith("http"));
  const hasLink =
    urls.length > 0 ||
    Boolean(evidence?.researchJobId) ||
    Boolean(evidence?.trendClusterId) ||
    Boolean(evidence?.agentRunId);
  if (!hasLink && !evidence?.operatorDraft) {
    throw new Error(
      "Add a source URL, or mark this as a manual draft with a rationale.",
    );
  }
  return {
    rationale,
    sourceUrls: urls,
    researchJobId: evidence?.researchJobId ?? null,
    trendClusterId: evidence?.trendClusterId ?? null,
    agentRunId: evidence?.agentRunId ?? null,
    claimSummaries: evidence?.claimSummaries ?? [],
    operatorDraft: evidence?.operatorDraft ?? false,
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

/**
 * Create a draft ContentPiece without an idea/brief chain.
 * Requires whyEvidence.rationale plus at least one http sourceUrl (or agentRunId).
 */
export async function createDraftPiece(input: {
  organisationId: string;
  title: string;
  body: string;
  platform?: string | null;
  rationale?: string | null;
  sourceUrl?: string | null;
  agentRunId?: string | null;
}): Promise<{ pieceId: string }> {
  const sourceUrl = input.sourceUrl?.trim() || "";
  const rationale =
    input.rationale?.trim() ||
    (sourceUrl ? "Draft created in Content OS" : "Manual draft created in Content OS");
  const why = assertWhyEvidence({
    rationale,
    sourceUrls: sourceUrl ? [sourceUrl] : [],
    agentRunId: input.agentRunId ?? null,
    operatorDraft: !sourceUrl && !input.agentRunId,
    claimSummaries:
      !sourceUrl && !input.agentRunId
        ? ["Operator-created draft without an external source URL."]
        : [],
  });

  const piece = await prisma.contentPiece.create({
    data: {
      organisationId: input.organisationId,
      title: input.title.trim(),
      body: input.body,
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

  return { pieceId: piece.id };
}

/**
 * Content approval state machine:
 *   DRAFT (or FAILED) --submit--> IN_REVIEW --approve--> APPROVED --publish--> SCHEDULED / PUBLISHED
 *                                 IN_REVIEW --reject---> DRAFT
 * Editing an APPROVED (or SCHEDULED, once its publish job is cancelled) piece sends it back to
 * DRAFT so the changed copy has to be reviewed again. Every transition is a conditional update on
 * the current status, so two people acting at once can't both win.
 */
export class ContentStateError extends Error {
  readonly code = "CONTENT_STATE";
}

const SUBMITTABLE_STATUSES: ContentPieceStatus[] = [ContentPieceStatus.DRAFT, ContentPieceStatus.FAILED];
/** Publish jobs that may still post the piece's current copy. */
const LIVE_PUBLISH_JOB_STATUSES: PublishingJobStatus[] = [
  PublishingJobStatus.PENDING_APPROVAL,
  PublishingJobStatus.APPROVED,
  PublishingJobStatus.QUEUED,
  PublishingJobStatus.SCHEDULED,
  PublishingJobStatus.DISPATCHING,
  PublishingJobStatus.PUBLISHING,
];

function notSubmittableMessage(status: ContentPieceStatus): string {
  switch (status) {
    case ContentPieceStatus.APPROVED:
    case ContentPieceStatus.SCHEDULED:
      return "This piece is already approved.";
    case ContentPieceStatus.PUBLISHED:
      return "This piece has already been published.";
    case ContentPieceStatus.ARCHIVED:
      return "Archived pieces can't be submitted for approval.";
    default:
      return "Only drafts can be submitted for approval.";
  }
}

export async function updatePiece(input: {
  organisationId: string;
  pieceId: string;
  title?: string;
  body?: string;
  platform?: string | null;
}): Promise<{ status: ContentPieceStatus; changed: boolean }> {
  const piece = await prisma.contentPiece.findFirst({
    where: { id: input.pieceId, organisationId: input.organisationId },
  });
  if (!piece) throw new Error("Piece not found");
  if (
    piece.status === ContentPieceStatus.PUBLISHED ||
    piece.status === ContentPieceStatus.ARCHIVED
  ) {
    throw new ContentStateError(
      piece.status === ContentPieceStatus.PUBLISHED
        ? "Published pieces can't be edited."
        : "Archived pieces can't be edited.",
    );
  }

  const title = input.title?.trim() ?? piece.title;
  const body = input.body ?? piece.body;
  const platform =
    input.platform !== undefined ? input.platform : piece.platform;
  const changed = title !== piece.title || body !== piece.body || platform !== piece.platform;
  if (!changed) return { status: piece.status, changed: false };

  // Approved copy that changes must be reviewed again.
  let nextStatus: ContentPieceStatus = piece.status;
  if (
    piece.status === ContentPieceStatus.APPROVED ||
    piece.status === ContentPieceStatus.SCHEDULED
  ) {
    const liveJobs = await prisma.publishingJob.count({
      where: {
        organisationId: input.organisationId,
        pieceId: piece.id,
        status: { in: LIVE_PUBLISH_JOB_STATUSES },
      },
    });
    if (liveJobs > 0) {
      throw new ContentStateError(
        "This piece is queued to publish. Cancel its publish job before editing, then submit it for approval again.",
      );
    }
    nextStatus = ContentPieceStatus.DRAFT;
  }

  const updated = await prisma.contentPiece.updateMany({
    where: { id: piece.id, organisationId: input.organisationId, status: piece.status },
    data: { title, body, platform, status: nextStatus },
  });
  if (updated.count === 0) {
    throw new ContentStateError("This piece changed while you were editing. Reload and try again.");
  }

  const last = await prisma.contentVersion.findFirst({
    where: { pieceId: piece.id, organisationId: input.organisationId },
    orderBy: { version: "desc" },
  });
  await prisma.contentVersion.create({
    data: {
      organisationId: input.organisationId,
      pieceId: piece.id,
      version: (last?.version ?? 0) + 1,
      title,
      body,
    },
  });
  return { status: nextStatus, changed: true };
}

export async function submitPieceForApproval(input: {
  organisationId: string;
  pieceId: string;
}): Promise<string> {
  const piece = await prisma.contentPiece.findFirst({
    where: { id: input.pieceId, organisationId: input.organisationId },
  });
  if (!piece) throw new Error("Piece not found");

  if (piece.status === ContentPieceStatus.IN_REVIEW) {
    // Already waiting — submitting twice is a no-op, not a second approval request.
    const pending = await prisma.contentApproval.findFirst({
      where: { organisationId: input.organisationId, pieceId: piece.id, decision: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    if (pending) return pending.id;
  } else if (!SUBMITTABLE_STATUSES.includes(piece.status)) {
    throw new ContentStateError(notSubmittableMessage(piece.status));
  }
  assertWhyEvidence(piece.whyEvidence as WhyEvidence);

  if (piece.status !== ContentPieceStatus.IN_REVIEW) {
    const moved = await prisma.contentPiece.updateMany({
      where: {
        id: piece.id,
        organisationId: input.organisationId,
        status: { in: SUBMITTABLE_STATUSES },
      },
      data: { status: ContentPieceStatus.IN_REVIEW },
    });
    if (moved.count === 0) {
      throw new ContentStateError("This piece changed in the meantime. Reload and try again.");
    }
  }

  const approval = await prisma.contentApproval.create({
    data: {
      organisationId: input.organisationId,
      pieceId: piece.id,
      decision: "PENDING",
    },
  });
  return approval.id;
}

/**
 * Approve or send back a piece that is IN_REVIEW. Callers must check the approver's permission
 * (the API requires automations:manage — the same permission as the Approvals queue).
 */
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
  if (piece.status !== ContentPieceStatus.IN_REVIEW) {
    throw new ContentStateError(
      piece.status === ContentPieceStatus.DRAFT || piece.status === ContentPieceStatus.FAILED
        ? "Submit this piece for approval before approving or sending it back."
        : piece.status === ContentPieceStatus.APPROVED || piece.status === ContentPieceStatus.SCHEDULED
          ? "This piece has already been approved."
          : "Only pieces awaiting approval can be approved or sent back.",
    );
  }

  // Claim the transition first: only one decision can move a piece out of review.
  const moved = await prisma.contentPiece.updateMany({
    where: {
      id: piece.id,
      organisationId: input.organisationId,
      status: ContentPieceStatus.IN_REVIEW,
    },
    data: {
      status:
        input.decision === "APPROVED"
          ? ContentPieceStatus.APPROVED
          : ContentPieceStatus.DRAFT,
    },
  });
  if (moved.count === 0) {
    throw new ContentStateError("Someone else already decided this piece. Reload to see where it is.");
  }

  const decided = {
    decision: input.decision,
    decidedByUserId: input.decidedByUserId ?? null,
    note: input.note ?? null,
    decidedAt: new Date(),
  };
  const closed = await prisma.contentApproval.updateMany({
    where: { organisationId: input.organisationId, pieceId: piece.id, decision: "PENDING" },
    data: decided,
  });
  if (closed.count === 0) {
    await prisma.contentApproval.create({
      data: { organisationId: input.organisationId, pieceId: piece.id, ...decided },
    });
  }
}

/**
 * Request publish via Kernel policy. Never marks PUBLISHED without a real external id.
 * Sets externalOutcome=PREPARED and a stable idempotencyKey. Emits CONTENT_PUBLISH_REQUESTED.
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

  let accountLabel = "(no connected account)";
  if (!input.socialConnectionId) {
    throw new Error("Select a connected social account to publish");
  }
  const { resolvePublishTargetConnection } = await import(
    "@/services/publishing/publish-targets"
  );
  const connection = await resolvePublishTargetConnection({
    organisationId: input.organisationId,
    socialConnectionId: input.socialConnectionId,
  });
  if (!connection) {
    throw new Error("Social connection not found for this workspace");
  }
  accountLabel =
    connection.displayName?.trim() ||
    `${connection.platform}:${connection.externalAccountId}`;

  const needsApproval = policy.effect === "require_approval";
  const scheduledFuture =
    Boolean(input.scheduledAt) && (input.scheduledAt as Date).getTime() > Date.now();
  const status = needsApproval
    ? PublishingJobStatus.PENDING_APPROVAL
    : scheduledFuture
      ? PublishingJobStatus.SCHEDULED
      : PublishingJobStatus.QUEUED;

  const idempotencyKey = buildPublishIdempotencyKey({
    organisationId: input.organisationId,
    pieceId: piece.id,
    platform: input.platform,
    socialConnectionId: input.socialConnectionId,
    scheduledAt: input.scheduledAt,
    variantId: input.variantId,
  });

  const existing = await prisma.publishingJob.findFirst({
    where: { organisationId: input.organisationId, idempotencyKey },
  });
  if (existing) {
    if (
      existing.externalOutcome === MissionExternalOutcome.CONFIRMED ||
      existing.status === PublishingJobStatus.PUBLISHED
    ) {
      return {
        jobId: existing.id,
        status: existing.status,
        policyEffect: policy.effect,
      };
    }
    if (existing.status !== PublishingJobStatus.CANCELLED) {
      return {
        jobId: existing.id,
        status: existing.status,
        policyEffect: policy.effect,
      };
    }
  }

  const actionDescription = formatPublishActionDescription({
    platform: input.platform,
    accountLabel,
    scheduledAt: input.scheduledAt ?? null,
    pieceTitle: piece.title,
  });

  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.publishingJob.create({
      data: {
        organisationId: input.organisationId,
        pieceId: piece.id,
        variantId: input.variantId ?? null,
        platform: input.platform,
        status,
        socialConnectionId: input.socialConnectionId ?? null,
        scheduledAt: input.scheduledAt ?? null,
        idempotencyKey,
        externalOutcome: MissionExternalOutcome.PREPARED,
        policySnapshot: {
          effect: policy.effect,
          reason: policy.reason,
          toolName: "social.publish",
        } as Prisma.InputJsonValue,
      },
    });

    if (needsApproval) {
      const approval = await tx.approvalRequest.create({
        data: {
          organisationId: input.organisationId,
          kind: "publish",
          title: `Publish to ${input.platform}`,
          summary: actionDescription,
          status: ApprovalRequestStatus.PENDING,
          payload: {
            kind: "publish",
            publishingJobId: created.id,
            organisationId: input.organisationId,
            platform: input.platform,
            socialConnectionId: input.socialConnectionId ?? null,
            scheduledAt: input.scheduledAt?.toISOString() ?? null,
            accountLabel,
            actionDescription,
            authorisedJobIds: [created.id],
          } as Prisma.InputJsonValue,
        },
      });
      await tx.publishingJob.update({
        where: { id: created.id },
        data: { approvalRequestId: approval.id },
      });
    }

    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "CONTENT_PUBLISH_REQUESTED",
      aggregateType: "PublishingJob",
      aggregateId: created.id,
      payload: {
        publishingJobId: created.id,
        contentPieceId: piece.id,
      },
      dedupeKey: `CONTENT_PUBLISH_REQUESTED:${created.id}`,
    });

    return created;
  });

  if (scheduledFuture && status !== PublishingJobStatus.PENDING_APPROVAL) {
    await prisma.contentPiece.updateMany({
      where: { id: piece.id, organisationId: input.organisationId },
      data: { status: ContentPieceStatus.SCHEDULED },
    });
  }

  return { jobId: job.id, status, policyEffect: policy.effect };
}

/**
 * Record a real publish result only.
 * - Success requires externalPostId or externalUrl → PUBLISHED + CONFIRMED + CONTENT_PUBLISHED
 * - Clear error → FAILED
 * - reconciliationRequired → RECONCILIATION_REQUIRED (never PUBLISHED / never CONFIRMED)
 * Never replays an already CONFIRMED job.
 */
export async function recordPublishResult(input: {
  organisationId: string;
  jobId: string;
  externalPostId?: string | null;
  externalUrl?: string | null;
  error?: string | null;
  reconciliationRequired?: boolean;
  reconciliationNote?: string | null;
}): Promise<void> {
  const job = await prisma.publishingJob.findFirst({
    where: { id: input.jobId, organisationId: input.organisationId },
  });
  if (!job) throw new Error("Publishing job not found");

  if (
    job.externalOutcome === MissionExternalOutcome.CONFIRMED ||
    job.status === PublishingJobStatus.PUBLISHED
  ) {
    return;
  }

  if (input.reconciliationRequired) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.publishingJob.updateMany({
        where: {
          id: job.id,
          organisationId: input.organisationId,
          externalOutcome: { not: MissionExternalOutcome.CONFIRMED },
          status: { not: PublishingJobStatus.PUBLISHED },
        },
        data: {
          status: PublishingJobStatus.RECONCILIATION_REQUIRED,
          externalOutcome: MissionExternalOutcome.RECONCILIATION_REQUIRED,
          error: input.error ?? job.error,
          reconciliationNote: (
            input.reconciliationNote ??
            input.error ??
            "Reconciliation required"
          ).slice(0, 4000),
        },
      });
      if (updated.count !== 1) return;
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "CONTENT_PUBLISH_RECONCILIATION_REQUIRED",
        aggregateType: "PublishingJob",
        aggregateId: job.id,
        payload: {
          publishingJobId: job.id,
          reason: (input.reconciliationNote ?? input.error ?? "Reconciliation required").slice(
            0,
            500,
          ),
        },
      });
    });
    return;
  }

  if (input.error) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.publishingJob.updateMany({
        where: {
          id: job.id,
          organisationId: input.organisationId,
          externalOutcome: { not: MissionExternalOutcome.CONFIRMED },
        },
        data: {
          status: PublishingJobStatus.FAILED,
          externalOutcome: MissionExternalOutcome.FAILED,
          error: input.error,
        },
      });
      if (updated.count !== 1) return;
      await tx.contentPiece.updateMany({
        where: { id: job.pieceId, organisationId: input.organisationId },
        data: { status: ContentPieceStatus.FAILED },
      });
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "CONTENT_PUBLISH_FAILED",
        aggregateType: "PublishingJob",
        aggregateId: job.id,
        payload: {
          publishingJobId: job.id,
          errorSummary: input.error!.slice(0, 500),
        },
      });
    });
    return;
  }

  if (!input.externalPostId?.trim() && !input.externalUrl?.trim()) {
    throw new Error("Cannot mark published without externalPostId or externalUrl from the platform");
  }

  const confirmedAt = new Date();
  await prisma.$transaction(async (tx) => {
    const updated = await tx.publishingJob.updateMany({
      where: {
        id: job.id,
        organisationId: input.organisationId,
        externalOutcome: { not: MissionExternalOutcome.CONFIRMED },
        status: { not: PublishingJobStatus.PUBLISHED },
      },
      data: {
        status: PublishingJobStatus.PUBLISHED,
        externalOutcome: MissionExternalOutcome.CONFIRMED,
        publishedAt: confirmedAt,
        confirmedAt,
        externalPostId: input.externalPostId ?? null,
        externalUrl: input.externalUrl ?? null,
        error: null,
        reconciliationNote: null,
      },
    });
    if (updated.count !== 1) return;

    await tx.contentPiece.updateMany({
      where: { id: job.pieceId, organisationId: input.organisationId },
      data: { status: ContentPieceStatus.PUBLISHED },
    });

    await appendDomainEvent(tx, {
      organisationId: input.organisationId,
      eventType: "CONTENT_PUBLISHED",
      aggregateType: "PublishingJob",
      aggregateId: job.id,
      payload: {
        publishingJobId: job.id,
        contentPieceId: job.pieceId,
        externalPostId: input.externalPostId?.trim() || undefined,
        externalUrl: input.externalUrl?.trim() || undefined,
        platform: job.platform,
      },
      dedupeKey: `CONTENT_PUBLISHED:${job.id}`,
    });
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
