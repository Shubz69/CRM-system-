import type { WebhookEvent } from "@prisma/client";
import { prisma } from "@/lib/db";
import { manychatWebhookSchema, type InboundMessageInput } from "@/schemas/webhook";

/** Error text the old retry wrote when it wrongly gave up on a ManyChat event. */
export const LEGACY_UNRETRIABLE_ERROR = "Payload is not a retriable inbound message shape";

export type WebhookReplay =
  | {
      ok: true;
      input: InboundMessageInput;
      options: { provider: string; rawPayload: unknown };
    }
  | { ok: false; reason: string };

type ReplayableEvent = Pick<
  WebhookEvent,
  "id" | "provider" | "organisationId" | "idempotencyKey" | "payload"
>;

/**
 * Rebuild the exact processInboundMessage call /api/webhooks/manychat made for this event.
 * Same provider + idempotency key, so the pipeline picks up the stored (FAILED) row and
 * reprocesses it in place; same message id, so a message stored by the failed attempt is
 * not duplicated.
 */
async function buildManyChatReplay(event: ReplayableEvent): Promise<WebhookReplay> {
  const organisationId = event.organisationId;
  if (!organisationId) {
    return { ok: false, reason: "This event has no workspace, so it can't be replayed." };
  }
  const parsed = manychatWebhookSchema.safeParse(event.payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "The stored ManyChat payload isn't valid, so it can't be replayed.",
    };
  }
  const data = parsed.data;
  const subscriberId = data.subscriber_id ? String(data.subscriber_id) : undefined;
  const text = data.text || data.message;
  if (!subscriberId || !text) {
    return {
      ok: false,
      reason:
        "The stored ManyChat payload has no subscriber_id or message text, so there is nothing to replay.",
    };
  }

  let channelExternalId = data.channel_id || undefined;
  if (!channelExternalId) {
    const channel = await prisma.messagingChannel.findFirst({
      where: { organisationId, provider: "manychat", isActive: true },
      orderBy: { createdAt: "asc" },
    });
    channelExternalId = channel?.externalId ?? undefined;
  }

  const fullName =
    data.name ||
    [data.first_name, data.last_name].filter(Boolean).join(" ") ||
    data.ig_username;

  // The webhook keys messages without a ManyChat id as `${organisationId}:${digest}` and
  // gives them the id `mc_${digest.slice(0, 32)}` — recover it from the stored key.
  const orgPrefix = `${organisationId}:`;
  const messageExternalId = data.id
    ? data.id
    : event.idempotencyKey.startsWith(orgPrefix)
      ? `mc_${event.idempotencyKey.slice(orgPrefix.length).slice(0, 32)}`
      : undefined;

  return {
    ok: true,
    input: {
      organisationId,
      channelExternalId,
      idempotencyKey: event.idempotencyKey,
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
    options: { provider: "manychat", rawPayload: event.payload },
  };
}

/**
 * Work out how to replay a stored inbound webhook. Providers whose stored payload can't be
 * turned back into the original message return a reason instead — the caller must leave
 * the event as it is (never mark it IGNORED just because it can't be retried here).
 */
export async function buildWebhookReplay(event: ReplayableEvent): Promise<WebhookReplay> {
  const provider = event.provider;
  if (provider === "manychat") return buildManyChatReplay(event);

  if (provider.endsWith("-retry")) {
    return {
      ok: false,
      reason: "This row records an earlier retry. Retry the original event instead.",
    };
  }
  if (provider === "meta_instagram") {
    return {
      ok: false,
      reason:
        "Instagram (Meta) events don't store the message text, so they can't be replayed from here. The webhook answered Meta with an error, so Meta can redeliver it. The event was left as it is.",
    };
  }
  if (provider === "zernio" || provider === "ZERNIO") {
    return {
      ok: false,
      reason: "Zernio events can't be replayed from here yet. The event was left as it is.",
    };
  }
  if (provider === "simulator" || provider === "manychat_test") {
    return {
      ok: false,
      reason: "Test messages can't be replayed. Send a new test message instead.",
    };
  }
  return {
    ok: false,
    reason: `Retry isn't supported for ${provider} events. The event was left unchanged.`,
  };
}
