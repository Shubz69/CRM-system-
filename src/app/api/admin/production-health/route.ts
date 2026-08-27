import { jsonError, requirePlatformAccess } from "@/lib/session";
import { getProductionHealth } from "@/services/enterprise-ops";

/**
 * GET /api/admin/production-health — FOUNDATION ops snapshot (DB/redis/outbox/worker age).
 * No paid provider pings; does not claim contractual SLO.
 */
export async function GET() {
  try {
    await requirePlatformAccess();
    const health = await getProductionHealth();
    return Response.json(health, { status: health.ok ? 200 : 503 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden") || message === "FORBIDDEN") {
      return jsonError(message, 403);
    }
    return jsonError(message, 500);
  }
}
