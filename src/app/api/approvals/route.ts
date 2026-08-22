import { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";
import { decideApprovalRequest } from "@/services/automation-os";

export async function GET() {
  try {
    const session = await requirePermission("automations:manage");
    const approvals = await prisma.approvalRequest.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        automationRule: { select: { id: true, name: true, triggerType: true } },
      },
    });
    return Response.json({ approvals });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const decideSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("automations:manage");
    const body = decideSchema.parse(await req.json());
    const result = await decideApprovalRequest({
      organisationId: session.organisationId,
      approvalId: body.id,
      decision: body.decision,
      decidedByUserId: session.userId,
      note: body.note,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
