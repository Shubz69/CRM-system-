import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  clarifyAndEnqueueAgentRun,
  createAndEnqueueAgentRun,
} from "@/services/agent-runs";

const createSchema = z.object({
  request: z.string().min(1).max(20_000),
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
    return jsonError(message, 503);
  }
}

const clarifySchema = z.object({
  runId: z.string().min(1),
  selectedOption: z.string().min(1).max(120),
});

/** Answer the single clarifying question with one tappable option. */
export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = clarifySchema.parse(await req.json());
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
