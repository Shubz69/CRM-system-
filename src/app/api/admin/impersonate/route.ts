import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";

const startSchema = z.object({
  action: z.literal("start"),
  targetUserId: z.string().min(1),
  organisationId: z.string().min(1),
});

const endSchema = z.object({
  action: z.literal("end"),
});

/**
 * Safe impersonation metadata endpoint.
 * Frontend stores a short-lived banner flag; JWT switch uses /api/session/organisation
 * after audit. Passwords are never revealed.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = z.union([startSchema, endSchema]).parse(await req.json());

    if (body.action === "end") {
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "impersonation.end",
        entityType: "User",
        entityId: session.userId,
      });
      return Response.json({ ok: true });
    }

    const target = await prisma.user.findFirst({
      where: { id: body.targetUserId, deletedAt: null },
      include: {
        memberships: {
          where: { organisationId: body.organisationId },
          include: { organisation: true },
        },
      },
    });
    if (!target || target.memberships.length === 0) {
      return jsonError("Target user is not a member of that workspace", 404);
    }
    if (target.isPlatformAdmin || target.memberships.some((m) => m.role === "SUPER_ADMIN")) {
      return jsonError("Cannot impersonate another platform administrator", 403);
    }

    await writeAuditLog({
      organisationId: body.organisationId,
      userId: session.userId,
      action: "impersonation.start",
      entityType: "User",
      entityId: target.id,
      metadata: {
        targetEmail: target.email,
        organisationName: target.memberships[0]?.organisation.name,
      },
    });

    return Response.json({
      ok: true,
      impersonation: {
        targetUserId: target.id,
        targetName: target.name || target.email,
        organisationId: body.organisationId,
        organisationName: target.memberships[0]?.organisation.name,
        startedAt: new Date().toISOString(),
        startedBy: session.email,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
