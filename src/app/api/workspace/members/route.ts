import { NextRequest } from "next/server";
import { z } from "zod";
import { MemberRole } from "@prisma/client";
import { jsonError, requirePermission } from "@/lib/session";
import {
  INVITE_ROLES,
  inviteMember,
  listMembers,
  listPendingInvites,
  OnboardingError,
} from "@/services/workspace-onboarding";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(MemberRole),
});

function mapOnboardingError(error: OnboardingError) {
  const status =
    error.code === "CONFLICT"
      ? 409
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "FORBIDDEN" || error.code === "REVOKED"
          ? 403
          : error.code === "EXPIRED" || error.code === "REPLAY"
            ? 410
            : 400;
  return jsonError(error.message, status);
}

export async function GET() {
  try {
    const session = await requirePermission("members:manage");
    const [members, invitations] = await Promise.all([
      listMembers(session.organisationId),
      listPendingInvites(session.organisationId),
    ]);
    return Response.json({
      members: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        createdAt: m.createdAt.toISOString(),
        user: {
          id: m.user.id,
          email: m.user.email,
          name: m.user.name,
          isActive: m.user.isActive,
          // Expose flag for UI isolation — never editable via this API.
          isPlatformAdmin: m.user.isPlatformAdmin,
        },
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: i.status,
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
      })),
      inviteRoles: INVITE_ROLES,
    });
  } catch (error) {
    if (error instanceof OnboardingError) return mapOnboardingError(error);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("members:manage");
    const body = inviteSchema.parse(await req.json());
    if (!INVITE_ROLES.includes(body.role)) {
      return jsonError(
        `Invite role must be one of: ${INVITE_ROLES.join(", ")}`,
        400,
      );
    }

    const result = await inviteMember({
      organisationId: session.organisationId,
      email: body.email,
      role: body.role,
      invitedByUserId: session.userId,
      includeInviteUrl: true,
    });

    return Response.json({
      ok: true,
      inviteId: result.inviteId,
      emailSent: result.emailSent,
      inviteUrl: result.inviteUrl,
      emailError: result.emailError,
    });
  } catch (error) {
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
