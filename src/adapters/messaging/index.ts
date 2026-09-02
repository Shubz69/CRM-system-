import { MockManyChatAdapter } from "@/adapters/messaging/mock-manychat";
import { createMetaInstagramMessagingAdapter } from "@/adapters/messaging/meta-instagram";
import { createZernioMessagingAdapter } from "@/adapters/messaging/zernio";
import type { MessagingAdapter, OutboundMessage, OutboundResult } from "@/adapters/messaging/types";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { allowMockTransports, isProductionRuntime } from "@/lib/runtime";
import { resolveMessagingSendCredential } from "@/services/messaging/credentials";
import {
  isMetaInstagramProvider,
  isZernioMessagingProvider,
  MESSAGING_PROVIDER,
} from "@/services/messaging/providers";
import { isZernioConfigured } from "@/adapters/zernio";

/**
 * Live ManyChat adapter.
 * In production, missing credentials fail closed — never silently use mock.
 */
export class ManyChatAdapter implements MessagingAdapter {
  readonly name = "manychat";

  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    const env = getEnv();
    const apiToken = message.apiToken ?? env.MANYCHAT_API_TOKEN;
    if (!apiToken) {
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
          Authorization: `Bearer ${apiToken}`,
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
        deliveryUncertain: true,
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

export async function getMessagingAdapterForOrganisation(
  organisationId: string,
  preferLive?: boolean,
  provider?: string,
): Promise<MessagingAdapter> {
  const credential = await resolveMessagingSendCredential(organisationId, { provider });
  const useZernio =
    isZernioMessagingProvider(provider) ||
    Boolean(credential.connectionRef?.startsWith("zernio:"));
  if (useZernio) {
    if (!isZernioConfigured() || !credential.token) {
      return new NotConfiguredMessagingAdapter(MESSAGING_PROVIDER.ZERNIO);
    }
    const live = createZernioMessagingAdapter();
    return {
      name: live.name,
      sendMessage(message) {
        return live.sendMessage({
          ...message,
          apiToken: message.apiToken ?? credential.token!,
          metadata: {
            ...(message.metadata ?? {}),
            ...(credential.igUserId ? { zernioAccountId: credential.igUserId } : {}),
          },
        });
      },
    };
  }

  const useMeta =
    isMetaInstagramProvider(provider) ||
    Boolean(credential.connectionRef?.startsWith("meta_instagram:"));

  if (useMeta) {
    if (!credential.token) {
      return new NotConfiguredMessagingAdapter(MESSAGING_PROVIDER.META_INSTAGRAM);
    }
    const live = createMetaInstagramMessagingAdapter();
    const igUserId = credential.igUserId ?? null;
    return {
      name: live.name,
      sendMessage(message) {
        return live.sendMessage({
          ...message,
          apiToken: message.apiToken ?? credential.token!,
          metadata: {
            ...(message.metadata ?? {}),
            igUserId: (message.metadata?.igUserId as string | undefined) ?? igUserId,
          },
        });
      },
    };
  }

  if (!credential.token) return getMessagingAdapter(preferLive);

  const live = new ManyChatAdapter();
  return {
    name: live.name,
    sendMessage(message) {
      return live.sendMessage({ ...message, apiToken: message.apiToken ?? credential.token! });
    },
  };
}

class NotConfiguredMessagingAdapter implements MessagingAdapter {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    void message;
    return {
      ok: false,
      provider: this.name,
      error: "Integration not configured",
    };
  }
}

export { MockManyChatAdapter } from "@/adapters/messaging/mock-manychat";
export {
  MetaInstagramMessagingAdapter,
  createMetaInstagramMessagingAdapter,
  normalizeMetaInstagramWebhookMessage,
  normalizeAllMetaInstagramWebhookMessages,
} from "@/adapters/messaging/meta-instagram";
export {
  ZernioMessagingAdapter,
  createZernioMessagingAdapter,
  normalizeZernioInboundMessage,
  zernioColdInstagramOutreachMode,
} from "@/adapters/messaging/zernio";
export {
  clearMockOutboundLog,
  mockOutboundLog,
  type MessagingAdapter,
  type MessagingAdapterCapabilities,
  type MessagingProviderAdapter,
  type NormalizedInboundMessage,
  type OutboundMessage,
  type OutboundResult,
} from "@/adapters/messaging/types";
