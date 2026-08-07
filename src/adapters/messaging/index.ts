import { MockManyChatAdapter } from "@/adapters/messaging/mock-manychat";
import type { MessagingAdapter, OutboundMessage, OutboundResult } from "@/adapters/messaging/types";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { allowMockTransports, isProductionRuntime } from "@/lib/runtime";

/**
 * Live ManyChat adapter.
 * In production, missing credentials fail closed — never silently use mock.
 */
export class ManyChatAdapter implements MessagingAdapter {
  readonly name = "manychat";

  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    const env = getEnv();
    if (!env.MANYCHAT_API_TOKEN) {
      if (isProductionRuntime() || !allowMockTransports()) {
        return {
          ok: false,
          provider: this.name,
          error: "ManyChat not configured (MANYCHAT_API_TOKEN missing)",
        };
      }
      logger.warn("MANYCHAT_API_TOKEN missing; using mock transport (non-production)");
      return new MockManyChatAdapter().sendMessage(message);
    }

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

/**
 * Resolve messaging adapter.
 * - preferLive === false → mock only when mocks are allowed (dev/test)
 * - production without token → NotConfigured adapter (fails closed)
 */
export function getMessagingAdapter(preferLive?: boolean): MessagingAdapter {
  const env = getEnv();

  if (preferLive === false) {
    if (allowMockTransports()) {
      return new MockManyChatAdapter();
    }
    // Production code paths that previously forced mock must use live or fail.
    if (!env.MANYCHAT_API_TOKEN) {
      return new NotConfiguredMessagingAdapter("manychat");
    }
    return new ManyChatAdapter();
  }

  if (!env.MANYCHAT_API_TOKEN) {
    if (allowMockTransports()) {
      return new MockManyChatAdapter();
    }
    return new NotConfiguredMessagingAdapter("manychat");
  }

  return new ManyChatAdapter();
}

class NotConfiguredMessagingAdapter implements MessagingAdapter {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async sendMessage(_message: OutboundMessage): Promise<OutboundResult> {
    return {
      ok: false,
      provider: this.name,
      error: "Integration not configured",
    };
  }
}

export { MockManyChatAdapter } from "@/adapters/messaging/mock-manychat";
export { clearMockOutboundLog, mockOutboundLog } from "@/adapters/messaging/types";
