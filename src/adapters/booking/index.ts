import { LinkBookingProvider, MockBookingProvider } from "./link";
import type { BookingProvider } from "./types";

export * from "./types";

export function getBookingProvider(provider = process.env.BOOKING_PROVIDER): BookingProvider {
  return provider === "mock" ? new MockBookingProvider() : new LinkBookingProvider();
}
