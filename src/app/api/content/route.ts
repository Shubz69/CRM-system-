import { listPublishTargets } from "@/services/publishing/publish-targets";
import { cancelPublishingJob } from "@/services/publishing";
import {
  createBriefAndPiece,
  createDraftPiece,
  createIdeaFromOpportunity,
  createOpportunityFromResearch,
  decidePieceApproval,
  requestPublish,
  submitPieceForApproval,
  updatePiece,
} from "@/services/content-os";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";
import { assertOrgExpensiveRouteAllowed, OrgRateLimitError } from "@/lib/org-rate-limit";
import { normalizeContentPlatform } from "@/lib/content-platform";

export async function GET() {
  try {
    const session = await requirePermission("ask:use");
    const [opportunities, pieces, jobs, publishTargets] = await Promise.all([
      prisma.contentOpportunity.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { createdAt: "desc" },
        take: 40,
        include: { ideas: { take: 3, orderBy: { createdAt: "desc" } } },
      }),
      prisma.contentPiece.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { updatedAt: "desc" },
        take: 40,
        include: {
          variants: true,
          brief: {
            select: {
              objective: true,
              idea: { select: { title: true, opportunity: { select: { title: true } } } },
            },
          },
          publishingJobs: { orderBy: { createdAt: "desc" }, take: 5 },
        },
      }),
      prisma.publishingJob.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      listPublishTargets(session.organisationId),
    ]);
    // Customer-safe publish targets — no provider vendor / raw external ids
    const customerTargets = publishTargets.map((t) => ({
      id: t.id,
      platform: t.platform,
      label: t.label,
      status: t.status,
      eligible: t.eligible,
    }));
    return Response.json({
      organisationId: session.organisationId,
      opportunities,
      pieces,
      publishingJobs: jobs,
      socialConnections: customerTargets.map((t) => ({
        id: t.id,
        platform: t.platform,
        displayName: t.label,
        status: t.status,
        eligible: t.eligible,
      })),
      publishTargets: customerTargets,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_opportunity_from_research"),
    researchJobId: z.string().min(1),
    agentRunId: z.string().optional(),
    title: z.string().max(200).optional(),
  }),
  z.object({
    action: z.literal("create_idea"),
    opportunityId: z.string().min(1),
    title: z.string().min(1).max(200),
    angle: z.string().max(2000).optional(),
    hook: z.string().max(500).optional(),
    formatHint: z.string().max(80).optional(),
  }),
  z.object({
    action: z.literal("create_brief_and_piece"),
    ideaId: z.string().min(1),
    pieceTitle: z.string().min(1).max(200),
    pieceBody: z.string().min(1).max(50_000),
    objective: z.string().max(2000).optional(),
    audience: z.string().max(1000).optional(),
    keyMessage: z.string().max(2000).optional(),
    cta: z.string().max(200).optional(),
    platform: z.string().max(40).optional(),
  }),
  z.object({
    action: z.literal("create_draft_piece"),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(50_000),
    rationale: z.string().max(4000).optional(),
    sourceUrl: z
      .string()
      .max(2000)
      .optional()
      .refine((v) => !v || /^https?:\/\//i.test(v), {
        message: "Source URL must start with http:// or https://",
      }),
    platform: z.string().max(40).optional(),
    agentRunId: z.string().optional(),
  }),
  z.object({
    action: z.literal("update_piece"),
    pieceId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(50_000).optional(),
    platform: z.string().max(40).nullable().optional(),
  }),
  z.object({
    action: z.literal("submit_approval"),
    pieceId: z.string().min(1),
  }),
  z.object({
    action: z.literal("decide_approval"),
    pieceId: z.string().min(1),
    decision: z.enum(["APPROVED", "REJECTED"]),
    note: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal("request_publish"),
    pieceId: z.string().min(1),
    platform: z.string().min(1).max(40),
    socialConnectionId: z.string().min(1),
    variantId: z.string().optional(),
    scheduledAt: z.string().datetime().optional(),
  }),
  z.object({
    action: z.literal("schedule_publish"),
    pieceId: z.string().min(1),
    platform: z.string().min(1).max(40),
    socialConnectionId: z.string().min(1),
    variantId: z.string().optional(),
    scheduledAt: z.string().datetime(),
  }),
  z.object({
    action: z.literal("cancel_publish_job"),
    jobId: z.string().min(1),
    reason: z.string().max(2000).optional(),
  }),
]);

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("ask:use");
    assertOrgExpensiveRouteAllowed(session.organisationId, "content");
    const body = postSchema.parse(await req.json());

    switch (body.action) {
      case "create_opportunity_from_research": {
        const id = await createOpportunityFromResearch({
          organisationId: session.organisationId,
          researchJobId: body.researchJobId,
          agentRunId: body.agentRunId,
          title: body.title,
        });
        return Response.json({ opportunityId: id });
      }
      case "create_idea": {
        const id = await createIdeaFromOpportunity({
          organisationId: session.organisationId,
          opportunityId: body.opportunityId,
          title: body.title,
          angle: body.angle,
          hook: body.hook,
          formatHint: body.formatHint,
        });
        return Response.json({ ideaId: id });
      }
      case "create_brief_and_piece": {
        const ids = await createBriefAndPiece({
          organisationId: session.organisationId,
          ...body,
        });
        return Response.json(ids);
      }
      case "create_draft_piece": {
        if (body.sourceUrl && !/^https?:\/\//i.test(body.sourceUrl)) {
          return jsonError("Source URL must start with http:// or https://", 400);
        }
        const platform = body.platform
          ? normalizeContentPlatform(body.platform)
          : null;
        if (body.platform && !platform) {
          return jsonError(
            "Choose a supported platform: Instagram, LinkedIn, YouTube, YouTube Short, or TikTok.",
            400,
          );
        }
        const result = await createDraftPiece({
          organisationId: session.organisationId,
          title: body.title,
          body: body.body,
          rationale: body.rationale,
          sourceUrl: body.sourceUrl,
          platform,
          agentRunId: body.agentRunId,
        });
        return Response.json({ ...result, organisationId: session.organisationId });
      }
      case "update_piece": {
        await updatePiece({
          organisationId: session.organisationId,
          pieceId: body.pieceId,
          title: body.title,
          body: body.body,
          platform: body.platform,
        });
        return Response.json({ ok: true });
      }
      case "submit_approval": {
        const approvalId = await submitPieceForApproval({
          organisationId: session.organisationId,
          pieceId: body.pieceId,
        });
        return Response.json({ approvalId });
      }
      case "decide_approval": {
        await decidePieceApproval({
          organisationId: session.organisationId,
          pieceId: body.pieceId,
          decision: body.decision,
          decidedByUserId: session.userId,
          note: body.note,
        });
        return Response.json({ ok: true });
      }
      case "request_publish":
      case "schedule_publish": {
        const scheduledAt =
          body.scheduledAt != null ? new Date(body.scheduledAt) : null;
        if (body.action === "schedule_publish" && (!scheduledAt || Number.isNaN(scheduledAt.getTime()))) {
          return jsonError("scheduledAt is required for schedule_publish", 400);
        }
        const result = await requestPublish({
          organisationId: session.organisationId,
          pieceId: body.pieceId,
          platform: body.platform,
          socialConnectionId: body.socialConnectionId,
          variantId: body.variantId,
          scheduledAt,
        });
        return Response.json(result);
      }
      case "cancel_publish_job": {
        await cancelPublishingJob({
          organisationId: session.organisationId,
          jobId: body.jobId,
          reason: body.reason,
        });
        return Response.json({ ok: true });
      }
      default:
        return jsonError("Unknown action", 400);
    }
  } catch (error) {
    if (error instanceof OrgRateLimitError) {
      return Response.json({ error: error.message, code: error.code }, { status: 429 });
    }
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      const field = first?.path?.join(".") || "input";
      const hint =
        field.includes("sourceUrl")
          ? "Source URL must be a full http(s) link, or leave it blank for a manual draft."
          : field.includes("rationale")
            ? "Add a short rationale, or leave advanced fields blank for a manual draft."
            : first?.message || "Please check the form and try again.";
      return jsonError(hint, 400);
    }
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
