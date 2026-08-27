import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";

/**
 * GET /api/social-intelligence — TrendCluster + recent metric snapshots + collection runs.
 * Empty arrays when no data; never fabricates charts or engagement.
 */
export async function GET() {
  try {
    const session = await requirePermission("insights:read");

    const [clusters, snapshots, collectionRuns] = await Promise.all([
      prisma.trendCluster.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { lastSeenAt: "desc" },
        take: 50,
        select: {
          id: true,
          key: true,
          label: true,
          kind: true,
          state: true,
          platforms: true,
          evidenceUrls: true,
          features: true,
          firstSeenAt: true,
          lastSeenAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.socialMetricSnapshot.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { capturedAt: "desc" },
        take: 40,
        select: {
          id: true,
          socialContentId: true,
          capturedAt: true,
          views: true,
          likes: true,
          comments: true,
          shares: true,
          score: true,
          socialContent: {
            select: {
              id: true,
              platform: true,
              url: true,
              title: true,
            },
          },
        },
      }),
      prisma.continuousCollectionRun.findMany({
        where: { organisationId: session.organisationId },
        orderBy: { observedAt: "desc" },
        take: 30,
        select: {
          id: true,
          kind: true,
          providerKey: true,
          status: true,
          observedAt: true,
          itemsCollected: true,
          errorSummary: true,
          createdAt: true,
        },
      }),
    ]);

    return Response.json({
      clusters,
      metricSnapshots: snapshots,
      collectionRuns,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
