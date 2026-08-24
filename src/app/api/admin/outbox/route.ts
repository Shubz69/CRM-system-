import { z } from "zod";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import {
  cancelDomainEvent,
  getDomainEventForOrg,
  getOutboxOpsSnapshot,
  retryDeadLetterEvent,
} from "@/services/domain-events";

/**
 * GET /api/admin/outbox — platform outbox snapshot (Postgres metrics).
 * Query: organisationId (optional filter for platform admin).
 */
export async function GET(req: Request) {
  try {
    await requirePlatformAccess();
    const url = new URL(req.url);
    const organisationId = url.searchParams.get("organisationId") || undefined;
    const eventId = url.searchParams.get("eventId");
    if (eventId && organisationId) {
      const event = await getDomainEventForOrg(organisationId, eventId);
      if (!event) return jsonError("Not found", 404);
      return Response.json({ event });
    }
    const snapshot = await getOutboxOpsSnapshot(organisationId);
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

const bodySchema = z.object({
  action: z.enum(["retry", "cancel"]),
  eventId: z.string().min(1),
  organisationId: z.string().min(1),
});

/**
 * POST /api/admin/outbox — retry or cancel a dead-letter / open event (tenant-scoped).
 */
export async function POST(req: Request) {
  try {
    const session = await requirePlatformAccess();
    const body = bodySchema.parse(await req.json());
    const actorUserId = session.userId;

    if (body.action === "retry") {
      await retryDeadLetterEvent({
        organisationId: body.organisationId,
        eventId: body.eventId,
        actorUserId,
      });
    } else {
      await cancelDomainEvent({
        organisationId: body.organisationId,
        eventId: body.eventId,
        actorUserId,
      });
    }
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden") || message === "FORBIDDEN") {
      return jsonError(message, 403);
    }
    return jsonError(message, 400);
  }
}
