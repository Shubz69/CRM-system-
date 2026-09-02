import { requirePlatformAccess, jsonError } from "@/lib/session";
import { buildIntegrationCapabilityMatrix } from "@/services/research-source-registry";

/**
 * GET /api/integrations/capability-matrix
 * Platform admin only — provider capability internals.
 */
export async function GET() {
  try {
    await requirePlatformAccess();
    const matrix = buildIntegrationCapabilityMatrix();
    return Response.json(matrix);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
