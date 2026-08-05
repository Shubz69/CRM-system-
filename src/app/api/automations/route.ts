import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";

export async function GET() {
  try {
    const session = await requirePermission("automations:manage");
    const rules = await prisma.automationRule.findMany({
      where: { organisationId: session.organisationId },
      include: {
        executions: { orderBy: { createdAt: "desc" }, take: 5 },
      },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json({ rules });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
