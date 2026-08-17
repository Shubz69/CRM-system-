import { NextRequest } from "next/server";
import { jsonError, requirePermission } from "@/lib/session";
import { logger } from "@/lib/logger";
import { getAgentRunProgress } from "@/services/agent-runs";
import {
  WorkspaceAccessError,
  assertActiveWorkspaceAccess,
  toUserFacingAskError,
} from "@/services/workspace-access";

/**
 * Progress poll for a run. Org-scoped — cross-org IDs return 404.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const session = await requirePermission("ask:use");
    await assertActiveWorkspaceAccess({
      userId: session.userId,
      organisationId: session.organisationId,
    });
    const { runId } = await context.params;
    if (!runId) return jsonError("runId required", 400);

    const progress = await getAgentRunProgress({
      organisationId: session.organisationId,
      runId,
    });
    if (!progress) return jsonError("Not found", 404);

    return Response.json(progress);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      const status = error.code === "NO_WORKSPACE_MEMBERSHIP" ? 403 : 401;
      return Response.json({ error: error.message, code: error.code }, { status });
    }
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    logger.warn("Ask progress error", { message });
    return jsonError(toUserFacingAskError(error), 500);
  }
}
