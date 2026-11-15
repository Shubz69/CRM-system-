import { NextRequest } from "next/server";
import { z } from "zod";
import { WebhookProcessingStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { jsonError, requirePlatformAccess } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";
import { processInboundMessage } from "@/services/inbound-pipeline";
import { recordUsage } from "@/services/usage";
import { buildWebhookReplay, LEGACY_UNRETRIABLE_ERROR } from "./replay";

const schema = z.object({
  webhookEventId: z.string().min(1),
});

/**
 * Inbound processing finishes within its 25s transaction budget; a row still PROCESSING
 * long after it arrived was abandoned by a crashed or timed-out request and would
 * otherwise stay stuck forever.
 */
const STUCK_PROCESSING_MS = 10 * 60 * 1000;

function isRetriable(event: { status: WebhookProcessingStatus; error: string | null }) {
  if (
    event.status === WebhookProcessingStatus.FAILED ||
    event.status === WebhookProcessingStatus.RECEIVED ||
    event.status === WebhookProcessingStatus.PROCESSING
  ) {
    return true;
  }
  // The old retry wrongly marked replayable ManyChat failures IGNORED — let those recover.
  return (
    event.status === WebhookProcessingStatus.IGNORED && event.error === LEGACY_UNRETRIABLE_ERROR
  );
}

function outcomeMessage(status: WebhookProcessingStatus | undefined, error: string | null) {
  if (status === WebhookProcessingStatus.PROCESSED) return "Retry completed — the message was processed.";
  if (status === WebhookProcessingStatus.DUPLICATE) return "Already processed.";
  if (status === WebhookProcessingStatus.IGNORED) {
    return `Replayed, but the message was not processed: ${error || "ignored"}.`;
  }
  return "Retry finished.";
}

/**
 * Replay a failed inbound webhook through the same processing the webhook route uses.
 * Same provider + idempotency key, so the stored row is reprocessed in place (no new row,
 * no duplicate message). Events that can't be replayed are left exactly as they are.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requirePlatformAccess();
    const body = schema.parse(await req.json());
    const event = await prisma.webhookEvent.findUnique({ where: { id: body.webhookEventId } });
    if (!event) return jsonError("Webhook event not found", 404);
    if (
      event.status === WebhookProcessingStatus.PROCESSED ||
      event.status === WebhookProcessingStatus.DUPLICATE
    ) {
      return Response.json({
        ok: true,
        duplicate: true,
        status: event.status,
        message: "Already processed",
      });
    }
    if (
      event.status === WebhookProcessingStatus.PROCESSING &&
      Date.now() - event.createdAt.getTime() < STUCK_PROCESSING_MS
    ) {
      return jsonError("This event is being processed right now. Refresh in a moment.", 409);
    }
    if (!isRetriable(event)) {
      return jsonError(`Only failed events can be retried (this one is ${event.status}).`, 409);
    }

    const replay = await buildWebhookReplay(event);
    if (!replay.ok) {
      // Leave the event FAILED: a provider we can't replay is not a reason to hide the failure.
      return jsonError(replay.reason, 422);
    }

    let result: Awaited<ReturnType<typeof processInboundMessage>> | null = null;
    let failure: string | null = null;
    try {
      result = await processInboundMessage(replay.input, replay.options);
    } catch (error) {
      failure = error instanceof Error ? error.message : "Inbound processing failed";
      logger.warn("Admin webhook retry failed", { webhookEventId: event.id, message: failure });
    }

    let after = await prisma.webhookEvent.findUnique({
      where: { id: event.id },
      select: { status: true, error: true },
    });
    if (!failure && after?.status === WebhookProcessingStatus.PROCESSED && after.error) {
      // The pipeline leaves the old failure text behind on success.
      after = await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { error: null },
        select: { status: true, error: true },
      });
    }

    await writeAuditLog({
      organisationId: event.organisationId ?? session.organisationId,
      userId: session.userId,
      action: "webhook.retry",
      entityType: "WebhookEvent",
      entityId: event.id,
      metadata: {
        provider: event.provider,
        outcome: after?.status ?? null,
        failed: Boolean(failure),
        duplicate: result?.duplicate ?? null,
      },
    });

    if (failure) {
      return Response.json(
        {
          error: `Retry failed: ${after?.error || failure}. The event is still marked failed.`,
          status: after?.status ?? WebhookProcessingStatus.FAILED,
        },
        { status: 500 },
      );
    }

    if (event.organisationId && after?.status === WebhookProcessingStatus.PROCESSED) {
      await recordUsage({
        organisationId: event.organisationId,
        feature: "webhook_inbound",
        provider: event.provider,
        metadata: { duplicate: result?.duplicate ?? false, adminRetry: true },
      });
    }

    return Response.json({
      ok: true,
      status: after?.status ?? null,
      message: outcomeMessage(after?.status, after?.error ?? null),
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
