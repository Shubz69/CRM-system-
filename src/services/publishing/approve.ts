/**
 * Phase 15 — approve a specific PublishingJob with an exact action description.
 * Approval of job A must not authorise job B.
 */

import {
  ApprovalRequestStatus,
  MissionExternalOutcome,
  PublishingJobStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureBuiltinToolsRegistered, evaluateToolPolicy } from "@/kernel";
import { formatPublishActionDescription } from "@/services/publishing/platform";

export { formatPublishActionDescription as describePublishActionSync } from "@/services/publishing/platform";

/** Build exact action text for a stored job (platform, account, schedule, job id). */
export async function describePublishAction(input: {
  organisationId: string;
  jobId: string;
}): Promise<string> {
  const job = await prisma.publishingJob.findFirst({
    where: { id: input.jobId, organisationId: input.organisationId },
    include: {
      piece: { select: { title: true } },
    },
  });
  if (!job) throw new Error("Publishing job not found");

  let accountLabel = "(no connected account)";
  if (job.socialConnectionId) {
    const conn = await prisma.socialConnection.findFirst({
      where: { id: job.socialConnectionId, organisationId: input.organisationId },
      select: { displayName: true, externalAccountId: true, platform: true },
    });
    if (conn) {
      accountLabel =
        conn.displayName?.trim() || `${conn.platform}:${conn.externalAccountId}`;
    }
  }

  return formatPublishActionDescription({
    platform: job.platform,
    accountLabel,
    scheduledAt: job.scheduledAt,
    pieceTitle: job.piece.title,
    jobId: job.id,
  });
}

/**
 * Approve one PublishingJob only. Payload is bound to that jobId —
 * deciding this approval cannot authorise a different job.
 */
export async function approvePublishingJob(input: {
  organisationId: string;
  jobId: string;
  decidedByUserId?: string | null;
  note?: string | null;
}): Promise<{
  jobId: string;
  actionDescription: string;
  status: PublishingJobStatus;
  approvalRequestId: string | null;
}> {
  ensureBuiltinToolsRegistered();
  const policy = evaluateToolPolicy("social.publish", {
    organisationId: input.organisationId,
  });
  if (policy.effect === "deny") {
    throw new Error(policy.reason || "Publishing is disabled by policy");
  }

  const actionDescription = await describePublishAction(input);

  const job = await prisma.publishingJob.findFirst({
    where: { id: input.jobId, organisationId: input.organisationId },
  });
  if (!job) throw new Error("Publishing job not found");
  if (job.status === PublishingJobStatus.CANCELLED) {
    throw new Error("Cannot approve a cancelled publishing job");
  }
  if (
    job.status === PublishingJobStatus.PUBLISHED ||
    job.externalOutcome === MissionExternalOutcome.CONFIRMED
  ) {
    return {
      jobId: job.id,
      actionDescription,
      status: job.status,
      approvalRequestId: job.approvalRequestId,
    };
  }
  if (job.status !== PublishingJobStatus.PENDING_APPROVAL) {
    throw new Error(`Job status ${job.status} is not approvable`);
  }

  const nextStatus =
    job.scheduledAt && job.scheduledAt.getTime() > Date.now()
      ? PublishingJobStatus.SCHEDULED
      : PublishingJobStatus.QUEUED;

  const approvalPayload = {
    kind: "publish" as const,
    publishingJobId: job.id,
    organisationId: input.organisationId,
    platform: job.platform,
    socialConnectionId: job.socialConnectionId,
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    actionDescription,
    /** Bound scope — execute/approve only this job. */
    authorisedJobIds: [job.id],
  };

  const result = await prisma.$transaction(async (tx) => {
    let approvalId = job.approvalRequestId;

    if (approvalId) {
      const existing = await tx.approvalRequest.findFirst({
        where: { id: approvalId, organisationId: input.organisationId },
      });
      if (!existing) {
        approvalId = null;
      } else if (existing.status !== ApprovalRequestStatus.PENDING) {
        throw new Error(`Linked approval already ${existing.status}`);
      } else {
        const payload = existing.payload as {
          publishingJobId?: string;
          authorisedJobIds?: string[];
        };
        const authorised =
          payload.publishingJobId === job.id ||
          (Array.isArray(payload.authorisedJobIds) &&
            payload.authorisedJobIds.includes(job.id));
        if (!authorised) {
          throw new Error(
            "Approval payload is not bound to this publishing job — refusing to approve",
          );
        }
        await tx.approvalRequest.update({
          where: { id: existing.id },
          data: {
            status: ApprovalRequestStatus.APPROVED,
            decidedByUserId: input.decidedByUserId ?? null,
            decidedAt: new Date(),
            decisionNote: input.note ?? null,
            summary: actionDescription,
            payload: { ...payload, ...approvalPayload },
          },
        });
      }
    }

    if (!approvalId) {
      const created = await tx.approvalRequest.create({
        data: {
          organisationId: input.organisationId,
          kind: "publish",
          title: `Publish to ${job.platform}`,
          summary: actionDescription,
          payload: approvalPayload,
          status: ApprovalRequestStatus.APPROVED,
          decidedByUserId: input.decidedByUserId ?? null,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
        },
      });
      approvalId = created.id;
    }

    const updated = await tx.publishingJob.updateMany({
      where: {
        id: job.id,
        organisationId: input.organisationId,
        status: PublishingJobStatus.PENDING_APPROVAL,
      },
      data: {
        status: nextStatus,
        approvalRequestId: approvalId,
        externalOutcome:
          job.externalOutcome === MissionExternalOutcome.NOT_STARTED
            ? MissionExternalOutcome.PREPARED
            : job.externalOutcome,
        policySnapshot: {
          ...((job.policySnapshot as object) ?? {}),
          approval: {
            decidedByUserId: input.decidedByUserId ?? null,
            note: input.note ?? null,
            actionDescription,
            decidedAt: new Date().toISOString(),
            jobId: job.id,
          },
        },
      },
    });
    if (updated.count !== 1) {
      throw new Error("Publishing job was no longer pending approval");
    }

    return { approvalId, nextStatus };
  });

  return {
    jobId: job.id,
    actionDescription,
    status: result.nextStatus,
    approvalRequestId: result.approvalId,
  };
}

export async function rejectPublishingJob(input: {
  organisationId: string;
  jobId: string;
  reason?: string | null;
}): Promise<void> {
  await prisma.publishingJob.updateMany({
    where: {
      id: input.jobId,
      organisationId: input.organisationId,
      status: PublishingJobStatus.PENDING_APPROVAL,
    },
    data: {
      status: PublishingJobStatus.CANCELLED,
      error: input.reason ?? "Approval rejected",
      externalOutcome: MissionExternalOutcome.FAILED,
    },
  });
}

export async function cancelPublishingJob(input: {
  organisationId: string;
  jobId: string;
  reason?: string | null;
}): Promise<void> {
  const job = await prisma.publishingJob.findFirst({
    where: { id: input.jobId, organisationId: input.organisationId },
  });
  if (!job) throw new Error("Publishing job not found");
  if (
    job.status === PublishingJobStatus.PUBLISHED ||
    job.externalOutcome === MissionExternalOutcome.CONFIRMED
  ) {
    throw new Error("Cannot cancel a confirmed published job");
  }
  if (job.status === PublishingJobStatus.DISPATCHING) {
    throw new Error(
      "Job is dispatching — cancel not safe; wait for outcome or reconcile",
    );
  }

  await prisma.publishingJob.updateMany({
    where: { id: job.id, organisationId: input.organisationId },
    data: {
      status: PublishingJobStatus.CANCELLED,
      error: input.reason ?? "Cancelled before dispatch",
    },
  });
}
