import { NextRequest } from "next/server";
import { jsonError, requirePermission, requireSession } from "@/lib/session";
import {
  discoverSocialProspects,
  getSocialProspectForOrg,
  listSocialProspects,
} from "@/services/social-prospecting/discovery";
import { ingestProspectToCrm } from "@/services/social-prospecting/crm-ingest";
import {
  markOutreachState,
  prepareProspectOutreach,
} from "@/services/social-prospecting/outreach";
import {
  linkedInV1ActionSurface,
  linkedInV2ActionSurface,
  sendConnectionInvitation,
  sendLinkedInMessage,
} from "@/services/social-prospecting/linkedin-native";
import { SocialCapabilityBlockedError } from "@/services/social-prospecting/capabilities";
import type { SocialProspectCandidateInput } from "@/services/social-prospecting/types";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession();
    const id = req.nextUrl.searchParams.get("id");
    if (id) {
      const prospect = await getSocialProspectForOrg(session.organisationId, id);
      if (!prospect) return jsonError("Not found", 404);
      return Response.json({
        prospect,
        linkedIn: linkedInV1ActionSurface(),
        linkedInV2: linkedInV2ActionSurface(),
      });
    }
    const prospects = await listSocialProspects(session.organisationId);
    return Response.json({
      prospects,
      linkedIn: linkedInV1ActionSurface(),
      linkedInV2: linkedInV2ActionSurface(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError(message, 401);
    return jsonError(message, 403);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("leads:write");
    const body = (await req.json()) as {
      action?: string;
      query?: string;
      /** Test/demo fixtures only — omit for live research discovery */
      seedCandidates?: SocialProspectCandidateInput[];
      skipLiveResearch?: boolean;
      costLimits?: {
        maxCandidates?: number;
        maxSources?: number;
        maxExternalCalls?: number;
        maxEstimatedCostCents?: number;
        maxResearchDepth?: "FAST" | "STANDARD" | "DEEP";
      };
      prospectId?: string;
      threadId?: string;
      mark?:
        | "CONNECTION_SENT"
        | "CONNECTED"
        | "FOLLOWUP_SENT"
        | "MESSAGE_SENT"
        | "REPLIED"
        | "LOST";
      offerSummary?: string;
      brandTone?: string;
      /** Forbidden unless LinkedIn approval flags enabled — will reject */
      attemptLinkedInSend?: boolean;
    };

    const action = body.action || "discover";

    if (action === "discover") {
      if (!body.query?.trim()) return jsonError("query required", 400);
      const result = await discoverSocialProspects({
        organisationId: session.organisationId,
        query: body.query,
        seedCandidates: body.seedCandidates,
        skipLiveResearch: body.skipLiveResearch,
        costLimits: body.costLimits,
      });
      return Response.json({
        ok: true,
        progress: {
          liveResearch: result.liveResearch,
          tiersTried: result.tiersTried,
          externalCalls: result.externalCalls,
          billableCents: result.billableCents,
          sourcesConfigured: result.sourcesConfigured,
          degraded: result.degraded,
          degradationNotes: result.degradationNotes,
          computeMode: result.computeMode,
        },
        ...result,
      });
    }

    if (action === "ingest") {
      if (!body.prospectId) return jsonError("prospectId required", 400);
      const result = await ingestProspectToCrm({
        organisationId: session.organisationId,
        prospectId: body.prospectId,
      });
      return Response.json({ ok: true, ...result });
    }

    if (action === "prepare_outreach") {
      if (!body.prospectId) return jsonError("prospectId required", 400);
      const result = await prepareProspectOutreach({
        organisationId: session.organisationId,
        prospectId: body.prospectId,
        offerSummary: body.offerSummary,
        brandTone: body.brandTone,
      });
      return Response.json({ ok: true, ...result });
    }

    if (action === "mark") {
      if (!body.threadId || !body.mark) return jsonError("threadId and mark required", 400);
      const updated = await markOutreachState({
        organisationId: session.organisationId,
        threadId: body.threadId,
        action: body.mark,
      });
      return Response.json({ ok: true, thread: updated, providerSent: false });
    }

    if (action === "linkedin_send_connection" || action === "linkedin_send_message") {
      // Always go through V2 adapter — rejects unless officially approved.
      try {
        if (action === "linkedin_send_connection") {
          await sendConnectionInvitation({
            organisationId: session.organisationId,
            profileUrl: body.query || "",
          });
        } else {
          await sendLinkedInMessage({
            organisationId: session.organisationId,
            recipientUrn: "",
            body: "",
          });
        }
      } catch (error) {
        if (error instanceof SocialCapabilityBlockedError) {
          return Response.json(
            {
              ok: false,
              code: error.code,
              error: error.message,
              fallback: linkedInV1ActionSurface(),
            },
            { status: 403 },
          );
        }
        throw error;
      }
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError(message, 401);
    if (message === "FORBIDDEN") return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
