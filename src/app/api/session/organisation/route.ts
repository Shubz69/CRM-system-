import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requireSession } from "@/lib/session";

const bodySchema = z.object({
  organisationId: z.string().min(1),
});

/**
 * Validates membership and returns the organisation the client should switch to.
 * The browser then calls `session.update({ organisationId })` so the JWT is updated.
 */
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const body = bodySchema.parse(await req.json());

    const membership = await prisma.organisationMember.findUnique({
      where: {
        organisationId_userId: {
          organisationId: body.organisationId,
          userId: session.userId,
        },
      },
      include: { organisation: true },
    });

    if (!membership) {
      return jsonError("Not a member of that organisation", 403);
    }

    return Response.json({
      organisationId: membership.organisationId,
      organisationName: membership.organisation.name,
      role: membership.role,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 400);
  }
}
