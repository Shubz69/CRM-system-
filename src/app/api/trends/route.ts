import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  evaluateDueForecasts,
  getForecastBacktestSummary,
  refreshTrendsForOrganisation,
} from "@/services/trend-intelligence";

/**
 * GET /api/trends — lifecycle clusters + optional backtest (null metrics if no history).
 */
export async function GET() {
  try {
    const session = await requirePermission("insights:read");
    await evaluateDueForecasts({ organisationId: session.organisationId }).catch(() => 0);

    const clusters = await prisma.trendCluster.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { lastSeenAt: "desc" },
      take: 50,
      include: {
        forecasts: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            horizon: true,
            probability: true,
            uncertainty: true,
            drivers: true,
            counterSignals: true,
            confidenceLabel: true,
            resolveAfter: true,
            createdAt: true,
          },
        },
      },
    });

    const backtest = await getForecastBacktestSummary({
      organisationId: session.organisationId,
    });

    return Response.json({ clusters, backtest });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

/** POST /api/trends — refresh trend features from recent signals/content. */
export async function POST() {
  try {
    const session = await requirePermission("insights:read");
    const result = await refreshTrendsForOrganisation({
      organisationId: session.organisationId,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
