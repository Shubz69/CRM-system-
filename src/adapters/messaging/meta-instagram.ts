import type {
  MessagingAdapter,
  MessagingProviderAdapter,
  NormalizedInboundMessage,
  OutboundMessage,
  OutboundResult,
} from "@/adapters/messaging/types";
import { assertMetaInstagramMessagingConfigured, getEnv } from "@/lib/env";
import { getMetaGraphVersion } from "@/services/messaging/meta-instagram";
import { MESSAGING_PROVIDER } from "@/services/messaging/providers";

/**
 * Native Meta Instagram Send API adapter (graph.instagram.com).
 * Must only be invoked via dispatchOutboundMessage — never from UI directly.
 */
export class MetaInstagramMessagingAdapter implements MessagingProviderAdapter {
  readonly name = MESSAGING_PROVIDER.META_INSTAGRAM;
  readonly capabilities = {
    sendText: true,
    sendMedia: false,
    templates: false,
    deliveryReceipts: false,
    readReceipts: false,
    typingIndicators: false,
  };

  normalizeInbound(payload: unknown): NormalizedInboundMessage | null {
    return normalizeMetaInstagramWebhookMessage(payload);
  }

  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    try {
      assertMetaInstagramMessagingConfigured();
    } catch (error) {
      return {
        ok: false,
        provider: this.name,
        error: error instanceof Error ? error.message : "Meta Instagram is not configured",
      };
    }

    const token = message.apiToken;
    if (!token) {
      return {
        ok: false,
        provider: this.name,
        error: "Meta Instagram credential missing",
      };
    }

    const igUserId =
      typeof message.metadata?.igUserId === "string" && message.metadata.igUserId.trim()
        ? message.metadata.igUserId.trim()
        : null;
    if (!igUserId) {
      return {
        ok: false,
        provider: this.name,
        error: "Connected Instagram Professional account id missing",
      };
    }

    // Recipient must be Instagram-scoped ID (IGSID), never username.
    const recipientId = message.contactExternalId?.trim();
    if (!recipientId || recipientId.startsWith("@")) {
      return {
        ok: false,
        provider: this.name,
        error: "Recipient must be an Instagram-scoped user id",
      };
    }

    const version = getMetaGraphVersion();
    const url = `https://graph.instagram.com/${version}/${encodeURIComponent(igUserId)}/messages`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: message.text },
        }),
      });

      const raw = await response.json().catch(() => null);
      if (!response.ok) {
        const errMsg =
          raw && typeof raw === "object" && "error" in raw
            ? String((raw as { error?: { message?: string } }).error?.message || response.status)
            : `Meta Instagram send failed (${response.status})`;
        return {
          ok: false,
          provider: this.name,
          error: errMsg,
          raw,
          // 5xx / network-ish — may have been accepted; outbound layer marks reconciliation
          deliveryUncertain: response.status >= 500,
        };
      }

      const messageId =
        raw && typeof raw === "object" && "message_id" in raw
          ? String((raw as { message_id: unknown }).message_id)
          : undefined;

      if (!messageId) {
        return {
          ok: false,
          provider: this.name,
          error: "Meta Instagram response missing message_id",
          raw,
          deliveryUncertain: true,
        };
      }

      return {
        ok: true,
        provider: this.name,
        externalMessageId: messageId,
        raw,
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.name,
        error: error instanceof Error ? error.message : "Meta Instagram send error",
        deliveryUncertain: true,
      };
    }
  }
}

type MetaMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: unknown[];
    reply_to?: unknown;
  };
  postback?: { payload?: string; title?: string; mid?: string };
};

/**
 * Extract the first actionable inbound text (or postback) from a Meta webhook body.
 * Echoes (business→user) are ignored for inbound CRM processing.
 */
export function normalizeMetaInstagramWebhookMessage(
  payload: unknown,
): NormalizedInboundMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as {
    object?: string;
    entry?: Array<{
      id?: string;
      time?: number;
      messaging?: MetaMessagingEvent[];
    }>;
  };

  // Instagram Messaging webhooks may use object "instagram" (Login) or page-style entries.
  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of events) {
      if (event.message?.is_echo) continue;
      const senderId = event.sender?.id;
      const recipientId = event.recipient?.id || entry.id;
      if (!senderId || !recipientId) continue;

      if (event.message?.mid && (event.message.text || event.message.attachments)) {
        const text =
          event.message.text?.trim() ||
          (event.message.attachments ? "[media]" : "");
        if (!text) continue;
        return {
          provider: MESSAGING_PROVIDER.META_INSTAGRAM,
          contactExternalId: senderId,
          text,
          threadId: `${recipientId}:${senderId}`,
          externalMessageId: event.message.mid,
          sentAt: event.timestamp
            ? new Date(event.timestamp).toISOString()
            : undefined,
          raw: {
            entryId: entry.id,
            recipientId,
            attachments: event.message.attachments ?? null,
            reply_to: event.message.reply_to ?? null,
          },
        };
      }

      if (event.postback?.payload) {
        return {
          provider: MESSAGING_PROVIDER.META_INSTAGRAM,
          contactExternalId: senderId,
          text: event.postback.title || event.postback.payload,
          threadId: `${recipientId}:${senderId}`,
          externalMessageId: event.postback.mid || `postback:${event.timestamp}:${senderId}`,
          sentAt: event.timestamp
            ? new Date(event.timestamp).toISOString()
            : undefined,
          raw: { entryId: entry.id, recipientId, postback: event.postback },
        };
      }
    }
  }
  return null;
}

/** Enumerate all normalized inbound messages from a webhook (multi-event batch). */
export function normalizeAllMetaInstagramWebhookMessages(
  payload: unknown,
): NormalizedInboundMessage[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as {
    entry?: Array<{ id?: string; messaging?: MetaMessagingEvent[] }>;
  };
  const out: NormalizedInboundMessage[] = [];
  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of events) {
      const single = normalizeMetaInstagramWebhookMessage({
        entry: [{ ...entry, messaging: [event] }],
      });
      if (single) out.push(single);
    }
  }
  return out;
}

export function createMetaInstagramMessagingAdapter(): MessagingAdapter {
  void getEnv(); // ensure env validated when constructing in app paths
  return new MetaInstagramMessagingAdapter();
}
