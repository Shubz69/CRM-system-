import { NextRequest } from "next/server";
import { handleBookingWebhook } from "@/services/booking-webhook";

export async function POST(req: NextRequest) {
  return handleBookingWebhook(req, { providerLabel: "booking" });
}
