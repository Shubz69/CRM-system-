import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { assertProductionSecretsConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import {
  assertWebhookTimestampFresh,
  parseWebhookTimestamp,
  readWebhookTimestampHeader,
  WebhookReplayError,
} from "@/lib/webhook-replay";
import { manychatWebhookSchema } from "@/schemas/webhook";
import { processInboundMessage } from "@/services/inbound-pipeline";
import { prisma } from "@/lib/db";
import { resolveManyChatWebhookOrganisation } from "@/services/manychat-secrets";
import { recordUsage } from "@/services/usage";

/** Message time a flow may include in the payload; tells repeat messages apart. */
function payloadTimestamp(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["timestamp", "sent_at", "created_at"]) {
    const value = record[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const parsed = parseWebhookTimestamp(value);
    if (parsed) return parsed.toISOString();
  }
  return null;
}

/**
 * WebhookEvent is unique on (provider, idempotencyKey) across every tenant, so keys carry
 * the organisation. Without a payload id the key needs a time component (payload timestamp,
 * else the current minute) — otherwise a second "yes" from the same subscriber is dropped
 * as a duplicate of the first.
 */
function manyChatMessageKeys(input: {
  organisationId: string;
  payload: unknown;
  id?: string;
  subscriberId: string;
  text: string;
  threadId?: string;
}): { idempotencyKey: string; messageExternalId: string } {
  if (input.id) {
    return { idempotencyKey: `${input.organisationId}:${input.id}`, messageExternalId: input.id };
  }
  const at =
    payloadTimestamp(input.payload) ?? `minute:${Math.floor(Date.now() / 60_000)}`;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        subscriberId: input.subscriberId,
        text: input.text,
        thread: input.threadId,
        at,
      }),
    )
    .digest("hex");
  return {
    idempotencyKey: `${input.organisationId}:${digest}`,
    // The pipeline's fallback message id is a prefix of the idempotency key, which is now the
    // organisation id for every message — give each message its own id instead.
    messageExternalId: `mc_${digest.slice(0, 32)}`,
  };
}

export async function POST(req: NextRequest) {
  try {
    assertProductionSecretsConfigured();
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`manychat:${ip}`, 120, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    try {
      assertWebhookTimestampFresh({
        timestamp: readWebhookTimestampHeader(req.headers),
      });
    } catch (error) {
      if (error instanceof WebhookReplayError) {
        return Response.json({ error: error.message }, { status: 401 });
      }
      throw error;
    }

    const secretHeader =
      req.headers.get("x-manychat-secret") ||
      req.headers.get("x-webhook-secret") ||
      "";

    const body = await req.json();
    const parsed = manychatWebhookSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
    }

    const data = parsed.data;
    let resolved: Awaited<ReturnType<typeof resolveManyChatWebhookOrganisation>>;
    try {
      resolved = await resolveManyChatWebhookOrganisation({
        secretHeader,
        payloadOrganisationId: data.organisationId,
        channelExternalId: data.channel_id,
      });
    } catch (error) {
      // The secret store could not be read, so the secret was not verified — reject as
      // unauthenticated rather than 500 (a bad secret must never look like a server fault).
      logger.warn("ManyChat webhook secret lookup failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
      return Response.json({ error: "Webhook secret could not be verified" }, { status: 401 });
    }

    if (!resolved.ok) {
      return Response.json({ error: resolved.error }, { status: resolved.status });
    }

    const organisationId = resolved.organisationId;
    let channelExternalId = resolved.channelExternalId;

    if (!channelExternalId) {
      const channel = await prisma.messagingChannel.findFirst({
        where: { organisationId, provider: "manychat", isActive: true },
        orderBy: { createdAt: "asc" },
      });
      channelExternalId = channel?.externalId ?? undefined;
    }

    const subscriberId = data.subscriber_id ? String(data.subscriber_id) : undefined;
    const text = data.text || data.message;
    if (!subscriberId || !text) {
      return Response.json({ error: "subscriber_id and text/message are required" }, { status: 400 });
    }

    const fullName =
      data.name ||
      [data.first_name, data.last_name].filter(Boolean).join(" ") ||
      data.ig_username;

    const { idempotencyKey, messageExternalId } = manyChatMessageKeys({
      organisationId,
      payload: body,
      id: data.id,
      subscriberId,
      text,
      threadId: data.thread_id,
    });

    const result = await processInboundMessage(
      {
        organisationId,
        channelExternalId,
        idempotencyKey,
        contact: {
          externalId: subscriberId,
          fullName,
          instagramUsername: data.ig_username,
          email: data.email,
          phone: data.phone,
        },
        message: { text, externalId: messageExternalId },
        threadId: data.thread_id,
        campaignSource: data.campaign,
        leadSource: "instagram_manychat",
      },
      { provider: "manychat", rawPayload: body },
    );

    await recordUsage({
      organisationId,
      feature: "webhook_inbound",
      provider: "manychat",
      metadata: { duplicate: result.duplicate, authMethod: resolved.authMethod },
    });

    return Response.json({ ok: true, result });
  } catch (error) {
    logger.error("ManyChat webhook failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
