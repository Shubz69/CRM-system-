import { NextRequest } from "next/server";
import { z } from "zod";
import {
  jsonError,
  requirePermissionForMutation,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import { logger } from "@/lib/logger";
import {
  clarifyAndEnqueueAgentRun,
  confirmImagingPromptAndEnqueue,
  createAndEnqueueAgentRun,
} from "@/services/agent-runs";
import { assertOrgExpensiveRouteAllowed, OrgRateLimitError } from "@/lib/org-rate-limit";
import {
  WorkspaceAccessError,
  assertActiveWorkspaceAccess,
  toUserFacingAskError,
} from "@/services/workspace-access";

const createSchema = z.object({
  request: z.string().min(1).max(20_000),
  referenceAssetId: z.string().min(1).optional(),
  answerMode: z.enum(["QUICK", "EXECUTIVE", "ACTION", "DEEP"]).optional(),
});

function askErrorResponse(error: unknown, fallbackStatus = 503) {
  if (error instanceof WorkspaceChangedError) {
    return workspaceChangedJsonResponse();
  }
  if (error instanceof OrgRateLimitError) {
    return Response.json({ error: error.message, code: error.code }, { status: 429 });
  }
  if (error instanceof WorkspaceAccessError) {
    const status = error.code === "NO_WORKSPACE_MEMBERSHIP" ? 403 : 401;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  const message = error instanceof Error ? error.message : "Failed";
  if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
  if (message.startsWith("Forbidden")) return jsonError(message, 403);
  if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
  if (message.includes("Reference image")) {
    return jsonError("That reference image wasn't found in your workspace.", 404);
  }
  if (message.includes("not awaiting")) {
    return jsonError("That step isn't waiting for an answer anymore. Refresh and try again.", 409);
  }

  logger.warn("Ask API error", {
    message,
    code: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined,
  });
  return jsonError(toUserFacingAskError(error), fallbackStatus);
}

/** Submit a natural-language request. Returns a run ID immediately. */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("ask:use", req, raw);
    await assertActiveWorkspaceAccess({
      userId: session.userId,
      organisationId: session.organisationId,
    });
    assertOrgExpensiveRouteAllowed(session.organisationId, "ask");
    const body = createSchema.parse(raw);
    const { runId, jobId } = await createAndEnqueueAgentRun({
      organisationId: session.organisationId,
      userId: session.userId,
      request: body.request,
      referenceAssetId: body.referenceAssetId ?? null,
      answerMode: body.answerMode ?? null,
    });
    return Response.json({
      ok: true,
      runId,
      jobId,
      answerMode: body.answerMode ?? null,
      message: "Started — you'll see progress as each step finishes.",
    });
  } catch (error) {
    return askErrorResponse(error, 503);
  }
}

const patchSchema = z.union([
  z.object({
    runId: z.string().min(1),
    selectedOption: z.string().min(1).max(120),
  }),
  z.object({
    runId: z.string().min(1),
    confirmedPrompt: z.string().min(8).max(4000),
  }),
]);

/** Answer clarification OR confirm an imaging prompt. */
export async function PATCH(req: NextRequest) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("ask:use", req, raw);
    await assertActiveWorkspaceAccess({
      userId: session.userId,
      organisationId: session.organisationId,
    });
    const body = patchSchema.parse(raw);

    if ("confirmedPrompt" in body) {
      const { runId, jobId } = await confirmImagingPromptAndEnqueue({
        organisationId: session.organisationId,
        runId: body.runId,
        confirmedPrompt: body.confirmedPrompt,
      });
      return Response.json({ ok: true, runId, jobId });
    }

    const { runId, jobId } = await clarifyAndEnqueueAgentRun({
      organisationId: session.organisationId,
      runId: body.runId,
      selectedOption: body.selectedOption,
    });
    return Response.json({ ok: true, runId, jobId });
  } catch (error) {
    return askErrorResponse(error, 400);
  }
}
