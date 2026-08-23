import { jsonError, requirePermission } from "@/lib/session";
import { getChiefOfStaffBriefing } from "@/services/enterprise-os";

/**
 * GET /api/chief-of-staff — Home briefing from real attention signals.
 */
export async function GET() {
  try {
    const session = await requirePermission("ask:use");
    const briefing = await getChiefOfStaffBriefing(session.organisationId);
    return Response.json(briefing);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
