import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { BookingStatus } from "@prisma/client";
import { getBookingProvider } from "@/adapters/booking";
import { getEnv, isDemoModeEnabled } from "@/lib/env";
import { prisma } from "@/lib/db";
import { cancelPendingFollowUps } from "@/services/followups";
import { writeAuditLog } from "@/services/audit";
import { notifyOnBooking } from "@/services/notifications";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    if (!rateLimit(`booking:${ip}`, 60, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const env = getEnv();
    const secret = req.headers.get("x-booking-secret") || "";
    if (!safeEqual(secret, env.BOOKING_WEBHOOK_SECRET)) {
      return Response.json({ error: "Invalid webhook secret" }, { status: 401 });
    }

    const rawBody = await req.json();
    const provider = getBookingProvider();
    const parsed = provider.parseWebhook(rawBody);
    if (!parsed) {
      return Response.json({ error: "Invalid booking webhook payload" }, { status: 400 });
    }

    const organisationIdFromBody =
      rawBody && typeof rawBody === "object" && "organisationId" in rawBody
        ? String((rawBody as { organisationId?: unknown }).organisationId || "")
        : "";

    let org =
      organisationIdFromBody
        ? await prisma.organisation.findFirst({
            where: { id: organisationIdFromBody, deletedAt: null },
          })
        : null;

    if (!org && isDemoModeEnabled()) {
      org = await prisma.organisation.findFirst({
        where: { deletedAt: null, demoData: true },
        orderBy: { createdAt: "asc" },
      });
    }

    if (!org) {
      return Response.json(
        { error: "organisationId required (no silent first-org fallback)" },
        { status: 400 },
      );
    }

    const eventKey = parsed.status.toLowerCase();
    const idempotencyKey = createHash("sha256")
      .update(`booking:${eventKey}:${parsed.externalId}`)
      .digest("hex");

    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { provider_idempotencyKey: { provider: "booking", idempotencyKey } },
    });
    if (existingEvent?.status === "PROCESSED") {
      return Response.json({ ok: true, duplicate: true });
    }

    await prisma.webhookEvent.upsert({
      where: { provider_idempotencyKey: { provider: "booking", idempotencyKey } },
      create: {
        organisationId: org.id,
        provider: "booking",
        eventType: eventKey,
        idempotencyKey,
        payload: rawBody as object,
        status: "PROCESSING",
      },
      update: { status: "PROCESSING", payload: rawBody as object },
    });

    const contactEmail =
      rawBody && typeof rawBody === "object" && typeof (rawBody as { contactEmail?: unknown }).contactEmail === "string"
        ? (rawBody as { contactEmail: string }).contactEmail
        : undefined;

    let contact = contactEmail
      ? await prisma.contact.findFirst({
          where: { organisationId: org.id, email: contactEmail },
        })
      : null;

    if (!contact && parsed.contactExternalId) {
      const ident = await prisma.contactIdentifier.findFirst({
        where: {
          organisationId: org.id,
          channel: "manychat",
          identifier: `manychat:${parsed.contactExternalId}`,
        },
        include: { contact: true },
      });
      contact = ident?.contact ?? null;
    }

    if (!contact) {
      return Response.json({ error: "Contact not found for booking" }, { status: 404 });
    }

    const lead = await prisma.lead.findFirst({
      where: { organisationId: org.id, contactId: contact.id, deletedAt: null },
      orderBy: { updatedAt: "desc" },
    });

    const bookedStage = await prisma.pipelineStage.findFirst({
      where: {
        slug: "booked",
        pipeline: { organisationId: org.id, isDefault: true },
      },
    });

    const bookingUrl =
      rawBody && typeof rawBody === "object" && typeof (rawBody as { bookingUrl?: unknown }).bookingUrl === "string"
        ? (rawBody as { bookingUrl: string }).bookingUrl
        : undefined;

    const bookingProviderName = env.BOOKING_PROVIDER === "mock" ? "mock" : "link";

    const booking = await prisma.booking.upsert({
      where: {
        organisationId_provider_externalId: {
          organisationId: org.id,
          provider: bookingProviderName,
          externalId: parsed.externalId,
        },
      },
      create: {
        organisationId: org.id,
        contactId: contact.id,
        conversationId: lead?.conversationId ?? undefined,
        leadId: lead?.id,
        provider: bookingProviderName,
        externalId: parsed.externalId,
        status: parsed.status as BookingStatus,
        scheduledAt: parsed.scheduledAt ?? null,
        bookingUrl,
      },
      update: {
        status: parsed.status as BookingStatus,
        scheduledAt: parsed.scheduledAt,
        bookingUrl,
      },
    });

    if (lead?.conversationId && ["CREATED", "RESCHEDULED"].includes(parsed.status)) {
      await cancelPendingFollowUps({
        conversationId: lead.conversationId,
        reason: "Booking webhook update",
      });
    }

    if (lead && bookedStage && parsed.status === "CREATED") {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { stageId: bookedStage.id },
      });
    }

    await notifyOnBooking({
      organisationId: org.id,
      bookingId: booking.id,
      event: eventKey,
    });

    await writeAuditLog({
      organisationId: org.id,
      action: `booking.${eventKey}`,
      entityType: "Booking",
      entityId: booking.id,
    });

    await prisma.webhookEvent.update({
      where: { provider_idempotencyKey: { provider: "booking", idempotencyKey } },
      data: { status: "PROCESSED", processedAt: new Date() },
    });

    return Response.json({ ok: true, bookingId: booking.id });
  } catch (error) {
    logger.error("Booking webhook failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return Response.json({ error: "Booking webhook failed" }, { status: 500 });
  }
}
