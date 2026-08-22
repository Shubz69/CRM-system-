import { requirePermission, jsonError } from "@/lib/session";
import { getCustomer360 } from "@/services/crm-v2";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/contacts/[id]/360 — evidence-based Customer 360.
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    const session = await requirePermission("leads:read");
    const { id } = await params;
    const view = await getCustomer360({
      organisationId: session.organisationId,
      contactId: id,
    });
    return Response.json(view);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (message === "Contact not found") return jsonError(message, 404);
    return jsonError(message, 500);
  }
}
