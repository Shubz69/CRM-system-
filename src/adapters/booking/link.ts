import type {
  BookingLinkInput,
  BookingLinkResult,
  BookingProvider,
  ParsedBookingWebhook,
} from "./types";
import { mockBookingLog } from "./types";

const EVENT_TO_STATUS: Record<string, ParsedBookingWebhook["status"]> = {
  created: "CREATED",
  CREATED: "CREATED",
  rescheduled: "RESCHEDULED",
  RESCHEDULED: "RESCHEDULED",
  cancelled: "CANCELLED",
  CANCELLED: "CANCELLED",
  attended: "ATTENDED",
  ATTENDED: "ATTENDED",
  no_show: "NO_SHOW",
  NO_SHOW: "NO_SHOW",
};

function parseCommonWebhook(payload: unknown): ParsedBookingWebhook | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Record<string, unknown>;
  if (typeof event.externalId !== "string") return null;

  const rawStatus =
    typeof event.event === "string"
      ? event.event
      : typeof event.status === "string"
        ? event.status
        : null;
  if (!rawStatus) return null;
  const status = EVENT_TO_STATUS[rawStatus];
  if (!status) return null;

  return {
    externalId: event.externalId,
    status,
    scheduledAt: typeof event.scheduledAt === "string" ? new Date(event.scheduledAt) : undefined,
    contactExternalId:
      typeof event.contactExternalId === "string" ? event.contactExternalId : undefined,
    metadata: event,
  };
}

export class LinkBookingProvider implements BookingProvider {
  readonly name = "link";

  async createBookingLink(input: BookingLinkInput): Promise<BookingLinkResult> {
    const base = input.bookingUrl ?? process.env.DEFAULT_BOOKING_URL;
    if (!base) {
      return { url: "", provider: this.name };
    }
    try {
      const url = new URL(base);
      url.searchParams.set("contact", input.contactId);
      if (input.conversationId) url.searchParams.set("conversation", input.conversationId);
      return { url: url.toString(), provider: this.name };
    } catch {
      return { url: base, provider: this.name };
    }
  }

  parseWebhook(payload: unknown): ParsedBookingWebhook | null {
    return parseCommonWebhook(payload);
  }
}

export class MockBookingProvider implements BookingProvider {
  readonly name = "mock";

  async createBookingLink(input: BookingLinkInput): Promise<BookingLinkResult> {
    const url = `https://mock.booking.local/book?contact=${encodeURIComponent(input.contactId)}${
      input.conversationId ? `&conversation=${encodeURIComponent(input.conversationId)}` : ""
    }`;
    mockBookingLog.push({ ...input, url });
    return { url, provider: this.name };
  }

  parseWebhook(payload: unknown) {
    return parseCommonWebhook(payload);
  }
}
