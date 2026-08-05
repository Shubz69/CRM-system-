import type { BookingLinkInput, BookingLinkResult, BookingProvider, ParsedBookingWebhook } from "./types";

export class LinkBookingProvider implements BookingProvider {
  async createBookingLink(input: BookingLinkInput): Promise<BookingLinkResult> {
    return { url: input.bookingUrl ?? process.env.DEFAULT_BOOKING_URL ?? "https://example.com/book", provider: "link" };
  }

  parseWebhook(payload: unknown): ParsedBookingWebhook | null {
    if (!payload || typeof payload !== "object") return null;
    const event = payload as Record<string, unknown>;
    if (typeof event.externalId !== "string" || typeof event.status !== "string") return null;
    const status = event.status;
    if (!["CREATED", "RESCHEDULED", "CANCELLED", "ATTENDED", "NO_SHOW"].includes(status)) return null;
    return { externalId: event.externalId, status: status as ParsedBookingWebhook["status"], scheduledAt: typeof event.scheduledAt === "string" ? new Date(event.scheduledAt) : undefined, metadata: event };
  }
}

export class MockBookingProvider implements BookingProvider {
  async createBookingLink(input: BookingLinkInput): Promise<BookingLinkResult> {
    return { url: `https://mock.booking.local/book?contact=${encodeURIComponent(input.contactId)}`, provider: "mock" };
  }

  parseWebhook(payload: unknown) {
    return new LinkBookingProvider().parseWebhook(payload);
  }
}
