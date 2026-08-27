export type OutboundMessage = {
  organisationId: string;
  contactExternalId: string;
  text: string;
  threadId?: string;
  apiToken?: string;
  metadata?: Record<string, unknown>;
};

export type OutboundResult = {
  ok: boolean;
  provider: string;
  externalMessageId?: string;
  raw?: unknown;
  error?: string;
  /** True only when the transport failed after dispatch may have reached the provider. */
  deliveryUncertain?: boolean;
};

export type MessagingAdapterCapabilities = {
  sendText: boolean;
  sendMedia?: boolean;
  templates?: boolean;
  deliveryReceipts?: boolean;
  readReceipts?: boolean;
  typingIndicators?: boolean;
};

export type NormalizedInboundMessage = {
  provider: string;
  contactExternalId: string;
  text: string;
  threadId?: string;
  externalMessageId?: string;
  sentAt?: string;
  raw?: unknown;
};

/**
 * Conceptual provider adapter surface.
 * ManyChat remains the only real adapter; other providers are not implemented.
 */
export type MessagingProviderAdapter = MessagingAdapter & {
  readonly capabilities?: MessagingAdapterCapabilities;
  normalizeInbound?(payload: unknown): NormalizedInboundMessage | null;
};

export type MessagingAdapter = {
  readonly name: string;
  sendMessage(message: OutboundMessage): Promise<OutboundResult>;
};

/** In-memory log of outbound messages for development/testing. */
export const mockOutboundLog: OutboundMessage[] = [];

export function clearMockOutboundLog(): void {
  mockOutboundLog.length = 0;
}
