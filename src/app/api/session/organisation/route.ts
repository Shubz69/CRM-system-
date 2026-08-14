import { z } from "zod";
import { jsonError, requireSession } from "@/lib/session";
import { resolveActiveWorkspaceForUser } from "@/services/active-workspace";

const bodySchema = z.object({
  organisationId: z.string().min(1),
});

/**
 * Switch the active workspace. Validates membership, persists
 * User.activeOrganisationId, and returns the org the client should put in the JWT
 * via `session.update({ organisationId })`.
 */
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const body = bodySchema.parse(await req.json());

    const resolved = await resolveActiveWorkspaceForUser({
      userId: session.userId,
      preferredOrganisationId: body.organisationId,
      persist: true,
    });

    if (!resolved || resolved.membership.organisationId !== body.organisationId) {
      return jsonError("Not a member of that organisation", 403);
    }

    return Response.json({
      organisationId: resolved.membership.organisationId,
      organisationName: resolved.membership.organisation.name,
      role: resolved.membership.role,
      isPlatform: resolved.membership.organisation.isPlatform,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError("Could not switch workspace. Please try again.", 400);
  }
}
