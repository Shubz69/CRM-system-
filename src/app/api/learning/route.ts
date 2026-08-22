import { NextRequest } from "next/server";
import { jsonError, requirePermission } from "@/lib/session";
import { getLearningDashboard } from "@/services/learning-os";

/**
 * GET /api/learning — feedback summary, experiments, candidates, evals, forecast backtest.
 */
export async function GET(_req: NextRequest) {
  try {
    const session = await requirePermission("insights:read");
    const dashboard = await getLearningDashboard(session.organisationId);
    return Response.json(dashboard);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
