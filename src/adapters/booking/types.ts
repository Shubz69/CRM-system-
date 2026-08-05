export type BookingLinkInput = {
  organisationId: string;
  contactId: string;
  conversationId?: string;
  leadId?: string;
  bookingUrl?: string;
};

export type BookingLinkResult = { url: string; provider: string };

export type ParsedBookingWebhook = {
  externalId: string;
  status: "CREATED" | "RESCHEDULED" | "CANCELLED" | "ATTENDED" | "NO_SHOW";
  scheduledAt?: Date;
  contactExternalId?: string;
  metadata?: Record<string, unknown>;
};

export interface BookingProvider {
  createBookingLink(input: BookingLinkInput): Promise<BookingLinkResult>;
  parseWebhook(payload: unknown): ParsedBookingWebhook | null;
}
