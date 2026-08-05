import { MockManyChatAdapter } from "@/adapters/messaging/mock-manychat";
import type { MessagingAdapter, OutboundMessage, OutboundResult } from "@/adapters/messaging/types";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Live ManyChat adapter skeleton.
 * Only uses a clearly marked generic send path — no undocumented endpoints are invented.
 * Prefer the mock adapter until real credentials and confirmed API routes are configured.
 */
export class ManyChatAdapter implements MessagingAdapter {
  readonly name = "manychat";

  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    const env = getEnv();
    if (!env.MANYCHAT_API_TOKEN) {
      logger.warn("MANYCHAT_API_TOKEN missing; falling back to mock transport");
      return new MockManyChatAdapter().sendMessage(message);
    }

    // ManyChat public sending APIs vary by account setup.
    // This adapter keeps a single configurable base URL and expects an organisation-specific
    // integration config to supply the concrete path when available.
    const url = `${env.MANYCHAT_API_BASE_URL.replace(/\/$/, "")}/fb/sending/sendContent`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.MANYCHAT_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subscriber_id: message.contactExternalId,
          data: {
            version: "v2",
            content: {
              messages: [{ type: "text", text: message.text }],
            },
          },
        }),
      });

      const raw = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          ok: false,
          provider: this.name,
          error: `ManyChat send failed (${response.status})`,
          raw,
        };
      }

      return {
        ok: true,
        provider: this.name,
        externalMessageId:
          typeof raw === "object" && raw && "message_id" in raw
            ? String((raw as { message_id: unknown }).message_id)
            : undefined,
        raw,
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.name,
        error: error instanceof Error ? error.message : "ManyChat send error",
      };
    }
  }
}

export function getMessagingAdapter(preferLive?: boolean): MessagingAdapter {
  const env = getEnv();
  if (preferLive === false || !env.MANYCHAT_API_TOKEN) {
    return new MockManyChatAdapter();
  }
  // Token present: use live unless explicitly forced to mock
  return new ManyChatAdapter();
}

export { MockManyChatAdapter } from "@/adapters/messaging/mock-manychat";
export { clearMockOutboundLog, mockOutboundLog } from "@/adapters/messaging/types";
