import { NextRequest } from "next/server";
import { handleBookingWebhook } from "@/services/booking-webhook";

/** Normalize Cal.com booking webhooks into the generic booking shape. */
function normalizeCalcom(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const body = raw as Record<string, unknown>;
  if (typeof body.externalId === "string" && (body.event || body.status)) return body;

  const payload = (body.payload || body) as Record<string, unknown>;
  const trigger = String(body.triggerEvent || body.event || payload.status || "CREATED");

  let status = "CREATED";
  if (/CANCEL/i.test(trigger)) status = "CANCELLED";
  else if (/RESCHEDULE/i.test(trigger)) status = "RESCHEDULED";
  else if (/NO_SHOW|NOSHOW/i.test(trigger)) status = "NO_SHOW";
  else if (/MEETING_ENDED|ATTENDED/i.test(trigger)) status = "ATTENDED";

  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const first = attendees[0] as { email?: string } | undefined;

  return {
    organisationId: body.organisationId || payload.organisationId,
    externalId: String(payload.uid || payload.id || `calcom_${Date.now()}`),
    event: status,
    status,
    scheduledAt: payload.startTime || payload.scheduledAt,
    contactEmail: first?.email || (typeof payload.email === "string" ? payload.email : undefined),
    bookingUrl: typeof payload.metadata === "object" && payload.metadata
      ? (payload.metadata as { videoCallUrl?: string }).videoCallUrl
      : undefined,
    contactExternalId: body.contactExternalId,
  };
}

export async function POST(req: NextRequest) {
  return handleBookingWebhook(req, {
    providerLabel: "calcom",
    normalizePayload: normalizeCalcom,
  });
}
