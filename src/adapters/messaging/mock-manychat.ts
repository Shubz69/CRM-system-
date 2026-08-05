import {
  mockOutboundLog,
  type MessagingAdapter,
  type OutboundMessage,
  type OutboundResult,
} from "@/adapters/messaging/types";
import { logger } from "@/lib/logger";

/**
 * Development transport that records outbound messages without calling ManyChat.
 * Live ManyChat HTTP details are intentionally not invented here.
 */
export class MockManyChatAdapter implements MessagingAdapter {
  readonly name = "manychat-mock";

  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    const externalMessageId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    mockOutboundLog.push({ ...message });
    logger.info("Mock ManyChat outbound message recorded", {
      contactExternalId: message.contactExternalId,
      textPreview: message.text.slice(0, 80),
      externalMessageId,
    });
    return {
      ok: true,
      provider: this.name,
      externalMessageId,
      raw: { stored: true },
    };
  }
}
