import { NextRequest } from "next/server";
import {
  ApprovalRequestStatus,
  MissionStatus,
  MissionTaskStatus,
  PublishingJobStatus,
} from "@prisma/client";
import { z } from "zod";
import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";
import { decideApprovalRequest } from "@/services/automation-os";
import {
  approvePublishingJob,
  rejectPublishingJob,
} from "@/services/publishing";
import {
  approveMissionTask,
  rejectMissionTask,
  resumeAfterApproval,
} from "@/services/mission-runtime";

export async function GET() {
  try {
    const session = await requirePermission("automations:manage");
    const [approvals, publishingPending, missionsPending] = await Promise.all([
      prisma.approvalRequest.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          automationRule: { select: { id: true, name: true, triggerType: true } },
        },
      }),
      prisma.publishingJob.findMany({
        where: {
          organisationId: session.organisationId,
          status: PublishingJobStatus.PENDING_APPROVAL,
        },
        orderBy: { createdAt: "desc" },
        take: 40,
        include: {
          piece: { select: { id: true, title: true, status: true } },
        },
      }),
      prisma.agentMission.findMany({
        where: {
          organisationId: session.organisationId,
          status: MissionStatus.WAITING_APPROVAL,
        },
        orderBy: { updatedAt: "desc" },
        take: 40,
        include: {
          tasks: {
            where: { status: MissionTaskStatus.WAITING_APPROVAL },
            select: {
              id: true,
              title: true,
              description: true,
              status: true,
              resultSummary: true,
            },
          },
        },
      }),
    ]);
    return Response.json({
      approvals,
      publishingJobs: publishingPending,
      missions: missionsPending,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const decideSchema = z.union([
  z.object({
    kind: z.literal("publishing_job"),
    jobId: z.string().min(1),
    decision: z.enum(["APPROVED", "REJECTED"]),
    note: z.string().max(2000).optional(),
  }),
  z.object({
    kind: z.literal("mission_task"),
    missionId: z.string().min(1),
    taskId: z.string().min(1),
    decision: z.enum(["APPROVED", "REJECTED"]),
    note: z.string().max(2000).optional(),
  }),
  z.object({
    kind: z.literal("approval_request").optional(),
    id: z.string().min(1),
    decision: z.enum(["APPROVED", "REJECTED"]),
    note: z.string().max(2000).optional(),
    editedContent: z.string().max(8000).optional(),
  }),
]);

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("automations:manage");
    const raw = await req.json();
    const body = decideSchema.parse(raw);

    if ("jobId" in body && body.kind === "publishing_job") {
      if (body.decision === "APPROVED") {
        const result = await approvePublishingJob({
          organisationId: session.organisationId,
          jobId: body.jobId,
          decidedByUserId: session.userId,
          note: body.note,
        });
        return Response.json({
          ok: true,
          kind: "publishing_job",
          ...result,
          message: `Job moved to ${result.status} — publish is not confirmed until an external post id exists`,
        });
      }
      await rejectPublishingJob({
        organisationId: session.organisationId,
        jobId: body.jobId,
        reason: body.note ?? "Rejected from Approvals",
      });
      return Response.json({ ok: true, kind: "publishing_job", status: "CANCELLED" });
    }

    if ("missionId" in body && body.kind === "mission_task") {
      if (body.decision === "APPROVED") {
        await approveMissionTask({
          organisationId: session.organisationId,
          missionId: body.missionId,
          taskId: body.taskId,
          approverUserId: session.userId,
        });
        await resumeAfterApproval({
          organisationId: session.organisationId,
          missionId: body.missionId,
          taskId: body.taskId,
        });
        return Response.json({ ok: true, kind: "mission_task", status: "RESUMED" });
      }
      await rejectMissionTask({
        organisationId: session.organisationId,
        missionId: body.missionId,
        taskId: body.taskId,
        approverUserId: session.userId,
        reason: body.note?.trim() || "Rejected from Approvals",
      });
      return Response.json({ ok: true, kind: "mission_task", status: "REJECTED" });
    }

    if (!("id" in body)) {
      return jsonError("Invalid approval decision payload", 400);
    }

    // Default: ApprovalRequest — for publish kind, route through approvePublishingJob
    const existing = await prisma.approvalRequest.findFirst({
      where: { id: body.id, organisationId: session.organisationId },
    });
    if (!existing) return jsonError("Approval request not found", 404);

    if (existing.kind === "publish") {
      const payload = existing.payload as { publishingJobId?: string };
      const jobId = payload.publishingJobId;
      if (!jobId) return jsonError("Publish approval missing publishingJobId", 400);
      if (body.decision === "APPROVED") {
        const result = await approvePublishingJob({
          organisationId: session.organisationId,
          jobId,
          decidedByUserId: session.userId,
          note: body.note,
        });
        return Response.json({
          ok: true,
          kind: "approval_request",
          ...result,
          message: `Job moved to ${result.status} — not published until external confirmation`,
        });
      }
      await rejectPublishingJob({
        organisationId: session.organisationId,
        jobId,
        reason: body.note ?? "Approval rejected",
      });
      await prisma.approvalRequest.updateMany({
        where: { id: existing.id, organisationId: session.organisationId },
        data: {
          status: ApprovalRequestStatus.REJECTED,
          decidedByUserId: session.userId,
          decidedAt: new Date(),
          decisionNote: body.note ?? null,
        },
      });
      return Response.json({ ok: true, kind: "approval_request", status: "REJECTED" });
    }

    const result = await decideApprovalRequest({
      organisationId: session.organisationId,
      approvalId: body.id,
      decision: body.decision,
      decidedByUserId: session.userId,
      note: body.note,
      editedContent: "editedContent" in body ? body.editedContent : undefined,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
