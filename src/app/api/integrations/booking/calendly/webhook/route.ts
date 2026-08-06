import { NextRequest } from "next/server";
import { handleBookingWebhook } from "@/services/booking-webhook";

/** Normalize Calendly invitee payloads into the generic booking shape. */
function normalizeCalendly(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const body = raw as Record<string, unknown>;
  if (typeof body.externalId === "string" && (body.event || body.status)) return body;

  const payload = (body.payload || body) as Record<string, unknown>;
  const event = String(body.event || payload.event || "");
  const uri =
    (typeof payload.uri === "string" && payload.uri) ||
    (typeof payload.invitee === "object" &&
      payload.invitee &&
      typeof (payload.invitee as { uri?: string }).uri === "string" &&
      (payload.invitee as { uri: string }).uri) ||
    "";

  let status = "CREATED";
  if (/canceled|cancelled/i.test(event)) status = "CANCELLED";
  else if (/reschedul/i.test(event)) status = "RESCHEDULED";
  else if (/no.?show/i.test(event)) status = "NO_SHOW";

  const email =
    typeof payload.email === "string"
      ? payload.email
      : typeof (payload.invitee as { email?: string } | undefined)?.email === "string"
        ? (payload.invitee as { email: string }).email
        : undefined;

  return {
    organisationId: body.organisationId,
    externalId: uri || String(payload.uuid || `calendly_${Date.now()}`),
    event: status,
    status,
    scheduledAt: payload.start_time || payload.scheduledAt,
    contactEmail: email,
    bookingUrl: payload.reschedule_url || payload.cancel_url,
    contactExternalId: body.contactExternalId,
  };
}

export async function POST(req: NextRequest) {
  return handleBookingWebhook(req, {
    providerLabel: "calendly",
    normalizePayload: normalizeCalendly,
  });
}
