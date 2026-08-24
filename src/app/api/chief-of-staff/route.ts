import { jsonError, requirePermission } from "@/lib/session";
import { getChiefOfStaffBriefing } from "@/services/enterprise-os";
import { buildChiefOfStaffFacts } from "@/services/chief-of-staff";

/**
 * GET /api/chief-of-staff — Home briefing from real attention signals + Phase 13 facts.
 * Query: ?v=2 for structured Goal/Opportunity sections.
 */
export async function GET(req: Request) {
  try {
    const session = await requirePermission("ask:use");
    const url = new URL(req.url);
    if (url.searchParams.get("v") === "2") {
      const facts = await buildChiefOfStaffFacts(session.organisationId);
      return Response.json(facts);
    }
    const briefing = await getChiefOfStaffBriefing(session.organisationId);
    const facts = await buildChiefOfStaffFacts(session.organisationId).catch(() => null);
    return Response.json({ ...briefing, phase13: facts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
