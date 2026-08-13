import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  clarifyAndEnqueueAgentRun,
  confirmImagingPromptAndEnqueue,
  createAndEnqueueAgentRun,
} from "@/services/agent-runs";

const createSchema = z.object({
  request: z.string().min(1).max(20_000),
  referenceAssetId: z.string().min(1).optional(),
});

/** Submit a natural-language request. Returns a run ID immediately. */
export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = createSchema.parse(await req.json());
    const { runId, jobId } = await createAndEnqueueAgentRun({
      organisationId: session.organisationId,
      userId: session.userId,
      request: body.request,
      referenceAssetId: body.referenceAssetId ?? null,
    });
    return Response.json({
      ok: true,
      runId,
      jobId,
      message: "Started — you'll see progress as each step finishes.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    if (message.includes("Reference image")) return jsonError(message, 404);
    return jsonError(message, 503);
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
    const session = await requirePermission("agent:manage");
    const body = patchSchema.parse(await req.json());

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
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    if (message.includes("not awaiting")) return jsonError(message, 409);
    return jsonError(message, 400);
  }
}
