/**
 * Zernio messaging adapter — Instagram permitted inbox only.
 * All sends must go through dispatchOutboundMessage(); never call this from UI directly.
 */

import type {
  MessagingAdapter,
  MessagingProviderAdapter,
  NormalizedInboundMessage,
  OutboundMessage,
  OutboundResult,
} from "@/adapters/messaging/types";
import { getEnv } from "@/lib/env";
import { isZernioConfigured } from "@/adapters/zernio";
import { MESSAGING_PROVIDER } from "@/services/messaging/providers";
import { recordSocialProviderUsage } from "@/services/social-prospecting/usage";

const ZERNIO_API_BASE = "https://zernio.com/api/v1";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Normalize Zernio message.received (and compatible shapes) into Agent Desk inbound.
 * Never invents sender IDs or message text.
 */
export function normalizeZernioInboundMessage(payload: unknown): NormalizedInboundMessage | null {
  const root = asRecord(payload);
  if (!root) return null;
  const event = String(root.event || root.type || "");
  if (event && event !== "message.received") return null;

  const message = asRecord(root.message) || {};
  const conversation = asRecord(root.conversation) || {};
  const account = asRecord(root.account) || {};
  const contact = asRecord(conversation.contact) || asRecord(message.sender) || asRecord(root.contact) || {};

  const platform = String(account.platform || root.platform || "").toLowerCase();
  if (platform && platform !== "instagram" && !platform.includes("instagram")) {
    // LinkedIn / other networks: do not ingest as Instagram DM inbox
    return null;
  }

  const contactExternalId = pickString(
    contact.id,
    contact.externalId,
    contact.platformId,
    message.senderId,
    conversation.contactId,
  );
  const text = pickString(message.text, message.body, message.content, root.text);
  if (!contactExternalId || !text) return null;

  const accountId = pickString(account.id, account.accountId, root.accountId);
  const zernioConversationId = pickString(conversation.id, conversation.conversationId, root.conversationId);
  const externalMessageId = pickString(
    message.platformMessageId,
    message.id,
    message.messageId,
    root.platformMessageId,
  );
  const sentAt = pickString(message.createdAt, message.sentAt, root.timestamp);

  return {
    provider: MESSAGING_PROVIDER.ZERNIO,
    contactExternalId,
    text,
    threadId: zernioConversationId
      ? `zernio:${accountId || "acct"}:${zernioConversationId}`
      : `zernio:${accountId || "acct"}:${contactExternalId}`,
    externalMessageId,
    sentAt,
    raw: {
      accountId,
      zernioConversationId,
      profileId: pickString(root.profileId, account.profileId),
      username: pickString(contact.username, contact.handle),
      displayName: pickString(contact.name, contact.displayName),
      platform: platform || "instagram",
    },
  };
}

export class ZernioMessagingAdapter implements MessagingAdapter, MessagingProviderAdapter {
  readonly name = MESSAGING_PROVIDER.ZERNIO;
  readonly capabilities = {
    sendText: true,
    sendMedia: false,
    deliveryReceipts: true,
    readReceipts: true,
  };

  normalizeInbound(payload: unknown): NormalizedInboundMessage | null {
    return normalizeZernioInboundMessage(payload);
  }

  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    if (!isZernioConfigured()) {
      return {
        ok: false,
        provider: this.name,
        error: "Zernio is not configured (ZERNIO_API_KEY missing)",
      };
    }

    const accountId = pickString(message.metadata?.zernioAccountId, message.metadata?.accountId);
    const conversationId = pickString(
      message.metadata?.zernioConversationId,
      message.threadId?.startsWith("zernio:")
        ? message.threadId.split(":").slice(2).join(":")
        : message.threadId,
      message.metadata?.conversationId,
    );

    if (!accountId || !conversationId) {
      return {
        ok: false,
        provider: this.name,
        error: "Zernio send requires zernioAccountId + zernioConversationId from an existing permitted conversation",
      };
    }

    const started = Date.now();
    try {
      const res = await fetch(
        `${ZERNIO_API_BASE}/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${getEnv().ZERNIO_API_KEY!.trim()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accountId,
            message: message.text,
          }),
        },
      );
      const raw = await res.json().catch(() => null);
      await recordSocialProviderUsage({
        organisationId: message.organisationId,
        provider: "ZERNIO",
        network: "INSTAGRAM",
        capability: "DIRECT_MESSAGES",
        latencyMs: Date.now() - started,
        errorCode: res.ok ? undefined : `http_${res.status}`,
      }).catch(() => undefined);

      if (!res.ok) {
        return {
          ok: false,
          provider: this.name,
          error: `Zernio send failed (${res.status})`,
          raw,
          deliveryUncertain: res.status >= 500,
        };
      }

      const data = asRecord(raw) || {};
      const nested = asRecord(data.data) || data;
      return {
        ok: true,
        provider: this.name,
        externalMessageId: pickString(nested.id, nested.messageId, nested.platformMessageId),
        raw,
      };
    } catch (error) {
      await recordSocialProviderUsage({
        organisationId: message.organisationId,
        provider: "ZERNIO",
        network: "INSTAGRAM",
        capability: "DIRECT_MESSAGES",
        latencyMs: Date.now() - started,
        errorCode: "network",
      }).catch(() => undefined);
      return {
        ok: false,
        provider: this.name,
        error: error instanceof Error ? error.message : "Zernio send error",
        deliveryUncertain: true,
      };
    }
  }
}

export function createZernioMessagingAdapter(): ZernioMessagingAdapter {
  return new ZernioMessagingAdapter();
}

/** Cold prospect outreach — never API send. */
export function zernioColdInstagramOutreachMode(): {
  mode: "HUMAN_ACTION_REQUIRED";
  actions: string[];
  sendMessage: false;
} {
  return {
    mode: "HUMAN_ACTION_REQUIRED",
    actions: ["OPEN_INSTAGRAM", "COPY_DM"],
    sendMessage: false,
  };
}
