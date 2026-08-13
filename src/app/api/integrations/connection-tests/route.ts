import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import {
  CONNECTION_TEST_IDS,
  getIntegrationReadiness,
  runConnectionTest,
  type ConnectionTestId,
} from "@/services/connection-tests";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requirePermission("integrations:manage");
    const readiness = await getIntegrationReadiness(session.organisationId);
    return Response.json(readiness);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError("Could not load connection status. Try again.", 500);
  }
}

const bodySchema = z.object({
  integration: z.enum(CONNECTION_TEST_IDS),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = bodySchema.parse(await req.json());
    const integration = body.integration as ConnectionTestId;

    const result = await runConnectionTest(session.organisationId, integration);

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "integration.connection_tested",
      entityType: "Integration",
      entityId: integration,
      metadata: { ok: result.ok, message: result.message },
    });

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) {
      return jsonError("Choose a valid integration to test.", 400);
    }
    return jsonError("Connection test failed unexpectedly. Try again.", 500);
  }
}
