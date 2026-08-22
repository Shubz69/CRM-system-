import { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  createBriefAndPiece,
  createIdeaFromOpportunity,
  createOpportunityFromResearch,
  decidePieceApproval,
  requestPublish,
  submitPieceForApproval,
} from "@/services/content-os";

export async function GET() {
  try {
    const session = await requirePermission("ask:use");
    const [opportunities, pieces, jobs] = await Promise.all([
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
          publishingJobs: { orderBy: { createdAt: "desc" }, take: 3 },
        },
      }),
      prisma.publishingJob.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
    ]);
    return Response.json({ opportunities, pieces, publishingJobs: jobs });
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
    socialConnectionId: z.string().optional(),
    variantId: z.string().optional(),
  }),
]);

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("ask:use");
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
      case "request_publish": {
        const result = await requestPublish({
          organisationId: session.organisationId,
          pieceId: body.pieceId,
          platform: body.platform,
          socialConnectionId: body.socialConnectionId,
          variantId: body.variantId,
        });
        return Response.json(result);
      }
      default:
        return jsonError("Unknown action", 400);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
