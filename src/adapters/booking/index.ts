import { LinkBookingProvider, MockBookingProvider } from "./link";
import type { BookingProvider } from "./types";

export * from "./types";
export { LinkBookingProvider, MockBookingProvider };

export function getBookingProvider(provider = process.env.BOOKING_PROVIDER || "link"): BookingProvider {
  return provider === "mock" ? new MockBookingProvider() : new LinkBookingProvider();
}
