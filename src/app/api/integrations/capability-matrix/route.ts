import { requirePermission, jsonError } from "@/lib/session";
import { buildIntegrationCapabilityMatrix } from "@/services/research-source-registry";

/**
 * GET /api/integrations/capability-matrix
 * Real credential/adapter status — never invents “connected” without evidence.
 */
export async function GET() {
  try {
    await requirePermission("integrations:manage");
    const matrix = buildIntegrationCapabilityMatrix();
    return Response.json(matrix);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
