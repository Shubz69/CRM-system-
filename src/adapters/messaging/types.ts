export type OutboundMessage = {
  organisationId: string;
  contactExternalId: string;
  text: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
};

export type OutboundResult = {
  ok: boolean;
  provider: string;
  externalMessageId?: string;
  raw?: unknown;
  error?: string;
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
