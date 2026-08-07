import { NextRequest } from "next/server";
import { z } from "zod";
import { WebhookProcessingStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { processInboundMessage } from "@/services/inbound-pipeline";
import type { InboundMessageInput } from "@/schemas/webhook";

const schema = z.object({
  webhookEventId: z.string().min(1),
});

/**
 * Idempotent retry for failed inbound webhooks.
 * Uses a new idempotency key suffix so DUPLICATE short-circuit does not block a deliberate retry,
 * while still recording the original event as retried.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = schema.parse(await req.json());
    const event = await prisma.webhookEvent.findUnique({ where: { id: body.webhookEventId } });
    if (!event) return jsonError("Webhook event not found", 404);
    if (event.status === WebhookProcessingStatus.PROCESSED) {
      return Response.json({ ok: true, duplicate: true, message: "Already processed" });
    }
    if (!event.organisationId) {
      return jsonError("Webhook has no organisation", 400);
    }

    const payload = event.payload as Record<string, unknown>;
    // Only retry structured inbound message payloads
    if (!payload || typeof payload !== "object" || !("contact" in payload) || !("message" in payload)) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: WebhookProcessingStatus.IGNORED,
          error: "Payload is not a retriable inbound message shape",
          processedAt: new Date(),
        },
      });
      return jsonError("Payload cannot be safely retried", 400);
    }

    const input = {
      ...(payload as unknown as InboundMessageInput),
      organisationId: event.organisationId,
      idempotencyKey: `${event.idempotencyKey}:retry:${event.id}`,
    };

    const result = await processInboundMessage(input, {
      provider: `${event.provider}-retry`,
      rawPayload: { originalEventId: event.id, payload: event.payload },
    });

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookProcessingStatus.PROCESSED,
        processedAt: new Date(),
        error: null,
      },
    });

    await writeAuditLog({
      organisationId: event.organisationId,
      userId: session.userId,
      action: "webhook.retry",
      entityType: "WebhookEvent",
      entityId: event.id,
      metadata: { resultWebhookEventId: result.webhookEventId, duplicate: result.duplicate },
    });

    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
