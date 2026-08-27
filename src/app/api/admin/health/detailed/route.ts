import { jsonError, requirePlatformAccess } from "@/lib/session";
import { getProductionHealth } from "@/services/enterprise-ops/health";
import { peekSloIndicators } from "@/services/enterprise-ops/slo";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/health/detailed — platform health + SLO indicators (no paid providers).
 */
export async function GET() {
  try {
    await requirePlatformAccess();
    const [health, slo] = await Promise.all([
      getProductionHealth(),
      peekSloIndicators(),
    ]);
    return Response.json({
      health,
      slo: {
        maturityNote: "FOUNDATION" as const,
        contractualSlo: false as const,
        indicators: slo,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden") || message === "FORBIDDEN") {
      return jsonError(message, 403);
    }
    return jsonError(message, 500);
  }
}
