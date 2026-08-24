import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  getIntegrationMeshSnapshot,
  runConnectorSync,
} from "@/services/connectors";

/**
 * GET /api/integrations/mesh — connector capability matrix + sync/health/skills.
 */
export async function GET() {
  try {
    const session = await requirePermission("integrations:manage");
    const snapshot = await getIntegrationMeshSnapshot(session.organisationId);
    return Response.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const bodySchema = z.object({
  action: z.enum(["run_demo_sync", "refresh_capabilities"]),
  providerKey: z.string().optional(),
  resource: z.string().optional(),
});

/**
 * POST — safe manual sync demo (mapping-only) or refresh capability evaluation.
 */
export async function POST(req: Request) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = bodySchema.parse(await req.json());

    if (body.action === "refresh_capabilities") {
      const snapshot = await getIntegrationMeshSnapshot(session.organisationId);
      return Response.json({ ok: true, connectors: snapshot.connectors });
    }

    if (body.action === "run_demo_sync") {
      const providerKey = body.providerKey ?? "manychat";
      const resource = body.resource ?? "contacts_demo";
      // Demo incremental sync uses durable cursor + mapping — no live provider scrape.
      const run = await runConnectorSync({
        organisationId: session.organisationId,
        providerKey,
        resource,
        fetchBatch: async (cursor) => {
          const stamp = cursor ? Number(cursor) : 0;
          if (stamp >= 1) {
            return { items: [], nextCursor: null, complete: true };
          }
          const externalId = `demo-${session.organisationId.slice(0, 6)}-1`;
          // Create a stable internal placeholder contact id mapping target.
          const contact = await (
            await import("@/lib/db")
          ).prisma.contact.findFirst({
            where: { organisationId: session.organisationId, deletedAt: null },
            select: { id: true },
          });
          if (!contact) {
            return { items: [], nextCursor: "1", complete: true };
          }
          return {
            items: [
              {
                externalId,
                externalType: "Contact",
                internalType: "Contact",
                internalId: contact.id,
              },
            ],
            nextCursor: "1",
            complete: true,
          };
        },
      });
      return Response.json({ ok: true, run });
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
