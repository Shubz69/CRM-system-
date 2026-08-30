import { jsonError, requirePermission } from "@/lib/session";
import {
  OnboardingError,
  resendInvite,
} from "@/services/workspace-onboarding";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const session = await requirePermission("members:manage");
    const { id } = await ctx.params;
    if (!id) return jsonError("Invitation id required", 400);

    const result = await resendInvite({
      organisationId: session.organisationId,
      inviteId: id,
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
    if (error instanceof OnboardingError) {
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "REVOKED" || error.code === "FORBIDDEN"
            ? 403
            : error.code === "REPLAY"
              ? 410
              : 400;
      return jsonError(error.message, status);
    }
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
