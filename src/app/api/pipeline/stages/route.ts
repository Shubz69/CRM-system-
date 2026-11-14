import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";

/**
 * Stages of the workspace's default pipeline — no leads, no contacts.
 * For screens that only need the stage list (inbox stage picker, CRM hub);
 * the pipeline board keeps using GET /api/pipeline.
 */
export async function GET() {
  try {
    const session = await requirePermission("leads:read");
    const pipeline = await prisma.pipeline.findFirst({
      where: { organisationId: session.organisationId, isDefault: true },
      select: {
        id: true,
        stages: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            name: true,
            slug: true,
            position: true,
            color: true,
            isWon: true,
            isLost: true,
          },
        },
      },
    });

    return Response.json({ pipelineId: pipeline?.id ?? null, stages: pipeline?.stages ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
