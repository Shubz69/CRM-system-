import { NextRequest } from "next/server";
import { z } from "zod";
import { MemberRole } from "@prisma/client";
import { jsonError, requirePermission, requirePermissionForMutation, WorkspaceChangedError, workspaceChangedJsonResponse } from "@/lib/session";
import {
  ASSIGNABLE_MEMBER_ROLES,
  changeMemberRole,
  OnboardingError,
  removeMember,
} from "@/services/workspace-onboarding";

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("role"),
    role: z.nativeEnum(MemberRole),
  }),
  z.object({
    action: z.literal("remove"),
  }),
]);

function mapOnboardingError(error: OnboardingError) {
  const status =
    error.code === "CONFLICT"
      ? 409
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "FORBIDDEN"
          ? 403
          : 400;
  return jsonError(error.message, status);
}

type Ctx = { params: Promise<{ userId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("members:manage", req, raw);
    const { userId } = await ctx.params;
    if (!userId) return jsonError("userId required", 400);

    const body = patchSchema.parse(raw);

    if (body.action === "remove") {
      const result = await removeMember({
        organisationId: session.organisationId,
        userId,
        actorUserId: session.userId,
      });
      return Response.json({ ok: true, ...result });
    }

    if (!ASSIGNABLE_MEMBER_ROLES.includes(body.role)) {
      return jsonError(
        `Role must be one of: ${ASSIGNABLE_MEMBER_ROLES.join(", ")}`,
        400,
      );
    }

    const updated = await changeMemberRole({
      organisationId: session.organisationId,
      userId,
      role: body.role,
      actorUserId: session.userId,
    });

    return Response.json({
      ok: true,
      member: { userId: updated.userId, role: updated.role },
    });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    if (error instanceof z.ZodError) {
      return jsonError(error.errors[0]?.message || "Invalid request", 400);
    }
    if (error instanceof OnboardingError) return mapOnboardingError(error);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
