import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requireSession } from "@/lib/session";
import { resolveActiveWorkspaceForUser } from "@/services/active-workspace";

const bodySchema = z.object({
  organisationId: z.string().min(1),
});

/**
 * Switch the active workspace.
 *
 * Authoritative contract:
 * 1. Validate membership
 * 2. Persist User.activeOrganisationId
 * 3. READ BACK from DB
 * 4. Verify readback matches the requested org
 * 5. Only then 200 — else 409 customer-safe (never claim success while session still elsewhere)
 *
 * Client must then refresh JWT via session.update and verify GET /api/organisations
 * before treating the switch as complete.
 */
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const body = bodySchema.parse(await req.json());
    const requestedId = body.organisationId;

    const resolved = await resolveActiveWorkspaceForUser({
      userId: session.userId,
      preferredOrganisationId: requestedId,
      persist: true,
    });

    if (!resolved || resolved.membership.organisationId !== requestedId) {
      return jsonError("Not a member of that organisation", 403);
    }

    // READ BACK — User.activeOrganisationId is the durable source of truth.
    const readback = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { activeOrganisationId: true },
    });

    if (!readback?.activeOrganisationId || readback.activeOrganisationId !== requestedId) {
      return Response.json(
        {
          error: "Workspace switch did not stick. Please try again.",
          code: "WORKSPACE_SWITCH_VERIFY_FAILED",
          requestedOrganisationId: requestedId,
          activeOrganisationId: readback?.activeOrganisationId ?? null,
        },
        { status: 409 },
      );
    }

    // Re-resolve from readback so response never lies about membership/role.
    const verified = await resolveActiveWorkspaceForUser({
      userId: session.userId,
      preferredOrganisationId: readback.activeOrganisationId,
      persist: false,
    });

    if (!verified || verified.membership.organisationId !== requestedId) {
      return Response.json(
        {
          error: "Workspace switch could not be confirmed. Please try again.",
          code: "WORKSPACE_SWITCH_VERIFY_FAILED",
          requestedOrganisationId: requestedId,
          activeOrganisationId: readback.activeOrganisationId,
        },
        { status: 409 },
      );
    }

    return Response.json({
      organisationId: verified.membership.organisationId,
      activeOrganisationId: verified.membership.organisationId,
      organisationName: verified.membership.organisation.name,
      role: verified.membership.role,
      isPlatform: verified.membership.organisation.isPlatform,
      verified: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError("Could not switch workspace. Please try again.", 400);
  }
}
