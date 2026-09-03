import { z } from "zod";
import { BusinessOpportunityStatus } from "@prisma/client";
import {
  jsonError,
  requirePermission,
  requirePermissionForMutation,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import {
  acceptOpportunityAsMission,
  getOpportunityForOrg,
  listOpportunities,
  recordOpportunityOutcome,
  runOpportunityDetectorsForOrg,
  transitionOpportunity,
} from "@/services/opportunities";

/**
 * GET /api/opportunities
 */
export async function GET(req: Request) {
  try {
    const session = await requirePermission("insights:read");
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (id) {
      const opportunity = await getOpportunityForOrg(session.organisationId, id);
      if (!opportunity) return jsonError("Not found", 404);
      return Response.json({ opportunity });
    }
    const status = url.searchParams.get("status") as BusinessOpportunityStatus | null;
    const opportunities = await listOpportunities(session.organisationId, {
      status: status || undefined,
    });
    return Response.json({ opportunities });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const bodySchema = z.object({
  action: z.enum([
    "accept",
    "reject",
    "dismiss",
    "create_mission",
    "run_detectors",
    "record_outcome",
  ]),
  opportunityId: z.string().optional(),
  result: z.enum(["SUCCESSFUL", "UNSUCCESSFUL", "INCONCLUSIVE", "IGNORED"]).optional(),
  summary: z.string().max(5000).optional(),
  measuredValueCents: z.number().int().optional(),
  currency: z.string().optional(),
  userJudgement: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("agent:manage", req, raw);
    const body = bodySchema.parse(raw);

    if (body.action === "run_detectors") {
      const result = await runOpportunityDetectorsForOrg(session.organisationId);
      return Response.json({ result });
    }
    if (!body.opportunityId) return jsonError("opportunityId required", 400);

    if (body.action === "accept") {
      const opportunity = await transitionOpportunity({
        organisationId: session.organisationId,
        opportunityId: body.opportunityId,
        to: "ACCEPTED",
        actorUserId: session.userId,
      });
      return Response.json({ opportunity });
    }
    if (body.action === "reject") {
      const opportunity = await transitionOpportunity({
        organisationId: session.organisationId,
        opportunityId: body.opportunityId,
        to: "REJECTED",
        actorUserId: session.userId,
      });
      return Response.json({ opportunity });
    }
    if (body.action === "dismiss") {
      const opportunity = await transitionOpportunity({
        organisationId: session.organisationId,
        opportunityId: body.opportunityId,
        to: "DISMISSED",
        actorUserId: session.userId,
      });
      return Response.json({ opportunity });
    }
    if (body.action === "create_mission") {
      const result = await acceptOpportunityAsMission({
        organisationId: session.organisationId,
        opportunityId: body.opportunityId,
        actorUserId: session.userId,
      });
      return Response.json(result);
    }
    if (body.action === "record_outcome") {
      if (!body.result) return jsonError("result required", 400);
      const outcome = await recordOpportunityOutcome({
        organisationId: session.organisationId,
        opportunityId: body.opportunityId,
        result: body.result,
        summary: body.summary,
        measuredValueCents: body.measuredValueCents,
        currency: body.currency,
        userJudgement: body.userJudgement,
      });
      return Response.json({ outcome });
    }
    return jsonError("Unknown action", 400);
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
