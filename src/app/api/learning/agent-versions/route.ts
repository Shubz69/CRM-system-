import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import {
  createAgentVersionCandidate,
  promoteAgentVersionCandidate,
  runEvalSuite,
} from "@/services/learning-os";

export async function GET() {
  try {
    const session = await requirePermission("agent:manage");
    const candidates = await prisma.agentVersionCandidate.findMany({
      where: { organisationId: session.organisationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return Response.json({ candidates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const createSchema = z.object({
  label: z.string().min(1),
  configSnapshot: z.record(z.unknown()).default({}),
  agentConfigurationId: z.string().optional().nullable(),
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("evaluate"), id: z.string().min(1) }),
  z.object({ action: z.literal("promote"), id: z.string().min(1) }),
]);

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = createSchema.parse(await req.json());
    const candidate = await createAgentVersionCandidate({
      organisationId: session.organisationId,
      label: body.label,
      configSnapshot: body.configSnapshot,
      agentConfigurationId: body.agentConfigurationId,
      createdByUserId: session.userId,
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "learning.agent_version_created",
      entityType: "AgentVersionCandidate",
      entityId: candidate.id,
    });
    return Response.json({ candidate });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requirePermission("agent:manage");
    const body = patchSchema.parse(await req.json());
    if (body.action === "evaluate") {
      const evalRun = await runEvalSuite({
        organisationId: session.organisationId,
        candidateId: body.id,
      });
      const candidate = await prisma.agentVersionCandidate.findFirst({
        where: { id: body.id, organisationId: session.organisationId },
      });
      return Response.json({ evalRun, candidate });
    }
    const candidate = await promoteAgentVersionCandidate({
      organisationId: session.organisationId,
      candidateId: body.id,
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "learning.agent_version_promoted",
      entityType: "AgentVersionCandidate",
      entityId: candidate.id,
    });
    return Response.json({ candidate });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
