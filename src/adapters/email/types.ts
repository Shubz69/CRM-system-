export type EmailDeliveryInput = {
  organisationId: string;
  to: string[];
  subject: string;
  bodyText: string;
  metadata?: Record<string, unknown>;
};

export type EmailDeliveryResult = {
  ok: boolean;
  provider: string;
  messageId?: string;
  error?: string;
};

export interface EmailAdapter {
  readonly name: string;
  send(input: EmailDeliveryInput): Promise<EmailDeliveryResult>;
}

export type MockEmailRecord = EmailDeliveryInput & { sentAt: string };

export const mockEmailLog: MockEmailRecord[] = [];

export function clearMockEmailLog(): void {
  mockEmailLog.length = 0;
}
