import { jsonError, requirePermission } from "@/lib/session";
import {
  OnboardingError,
  revokeInvite,
} from "@/services/workspace-onboarding";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const session = await requirePermission("members:manage");
    const { id } = await ctx.params;
    if (!id) return jsonError("Invitation id required", 400);

    const result = await revokeInvite({
      organisationId: session.organisationId,
      inviteId: id,
      revokedByUserId: session.userId,
    });

    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof OnboardingError) {
      const status =
        error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
      return jsonError(error.message, status);
    }
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
