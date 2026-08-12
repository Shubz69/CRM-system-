import { NextRequest } from "next/server";
import { jsonError, requirePermission } from "@/lib/session";
import { getAgentRunProgress } from "@/services/agent-runs";

/**
 * Progress poll for a run. Org-scoped — cross-org IDs return 404.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const session = await requirePermission("agent:manage");
    const { runId } = await context.params;
    if (!runId) return jsonError("runId required", 400);

    const progress = await getAgentRunProgress({
      organisationId: session.organisationId,
      runId,
    });
    if (!progress) return jsonError("Not found", 404);

    return Response.json(progress);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
