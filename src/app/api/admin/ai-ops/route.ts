import { jsonError, requirePlatformAccess } from "@/lib/session";
import { getAiOpsSnapshot } from "@/services/enterprise-os";

/**
 * GET /api/admin/ai-ops — platform AI Ops snapshot (real queues / failures / runs).
 */
export async function GET() {
  try {
    await requirePlatformAccess();
    const snapshot = await getAiOpsSnapshot();
    return Response.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden") || message === "FORBIDDEN") {
      return jsonError(message, 403);
    }
    return jsonError(message, 500);
  }
}
