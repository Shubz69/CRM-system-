import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { BookingStatus } from "@prisma/client";
import { getBookingProvider } from "@/adapters/booking";
import { getEnv, isDemoModeEnabled, assertWebhookSecretsConfigured } from "@/lib/env";
import { prisma } from "@/lib/db";
import { cancelPendingFollowUps } from "@/services/followups";
import { writeAuditLog } from "@/services/audit";
import { notifyOnBooking } from "@/services/notifications";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { runAutomations } from "@/services/automations";
import { recordUsage } from "@/services/usage";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function stageSlugForStatus(status: string): string | null {
  switch (status) {
    case "CREATED":
    case "RESCHEDULED":
      return "booked";
    case "CANCELLED":
      return "lost";
    case "ATTENDED":
      return "attended";
    case "NO_SHOW":
      return "no_show";
    default:
      return null;
  }
}

/** Shared booking webhook processor used by generic + provider-specific routes. */
export async function handleBookingWebhook(
  req: NextRequest,
  options?: { providerLabel?: string; normalizePayload?: (raw: unknown) => unknown },
) {
  try {
    assertWebhookSecretsConfigured();
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    const providerLabel = options?.providerLabel || "booking";
    if (!rateLimit(`${providerLabel}:${ip}`, 60, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const env = getEnv();
    const secret =
      req.headers.get("x-booking-secret") ||
      req.headers.get("x-calendly-secret") ||
      req.headers.get("x-cal-secret") ||
      "";
    if (!safeEqual(secret, env.BOOKING_WEBHOOK_SECRET)) {
      return Response.json({ error: "Invalid webhook secret" }, { status: 401 });
    }

    const rawIncoming = await req.json();
    const rawBody = options?.normalizePayload
      ? options.normalizePayload(rawIncoming)
      : rawIncoming;

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
      .update(`${providerLabel}:${eventKey}:${parsed.externalId}`)
      .digest("hex");

    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { provider_idempotencyKey: { provider: providerLabel, idempotencyKey } },
    });
    if (existingEvent?.status === "PROCESSED") {
      return Response.json({ ok: true, duplicate: true });
    }

    await prisma.webhookEvent.upsert({
      where: { provider_idempotencyKey: { provider: providerLabel, idempotencyKey } },
      create: {
        organisationId: org.id,
        provider: providerLabel,
        eventType: eventKey,
        idempotencyKey,
        payload: rawIncoming as object,
        status: "PROCESSING",
      },
      update: { status: "PROCESSING", payload: rawIncoming as object },
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

    const targetSlug = stageSlugForStatus(parsed.status);
    const targetStage = targetSlug
      ? await prisma.pipelineStage.findFirst({
          where: {
            slug: targetSlug,
            pipeline: { organisationId: org.id, isDefault: true },
          },
        })
      : null;

    const bookingUrl =
      rawBody && typeof rawBody === "object" && typeof (rawBody as { bookingUrl?: unknown }).bookingUrl === "string"
        ? (rawBody as { bookingUrl: string }).bookingUrl
        : undefined;

    const bookingProviderName =
      providerLabel === "calendly" || providerLabel === "calcom"
        ? providerLabel
        : env.BOOKING_PROVIDER === "mock"
          ? "mock"
          : "link";

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

    // Promote any OFFERED booking for this lead to CREATED when confirmed.
    if (lead && parsed.status === "CREATED") {
      await prisma.booking.updateMany({
        where: { leadId: lead.id, organisationId: org.id, status: BookingStatus.OFFERED },
        data: { status: BookingStatus.CREATED, externalId: parsed.externalId },
      });
    }

    if (lead?.conversationId && ["CREATED", "RESCHEDULED"].includes(parsed.status)) {
      await cancelPendingFollowUps({
        organisationId: org.id,
        conversationId: lead.conversationId,
        reason: "Booking webhook update",
      });
    }

    if (lead && targetStage) {
      await prisma.lead.updateMany({
        where: { id: lead.id, organisationId: org.id },
        data: { stageId: targetStage.id },
      });
    }

    await notifyOnBooking({
      organisationId: org.id,
      bookingId: booking.id,
      event: eventKey,
    });

    if (lead) {
      await runAutomations({
        organisationId: org.id,
        contactId: contact.id,
        conversationId: lead.conversationId ?? undefined,
        leadId: lead.id,
        triggerType:
          parsed.status === "CREATED"
            ? "booking_created"
            : parsed.status === "CANCELLED"
              ? "booking_cancelled"
              : parsed.status === "RESCHEDULED"
                ? "booking_rescheduled"
                : "booking_updated",
        payload: { bookingId: booking.id, status: parsed.status },
      });
    }

    await writeAuditLog({
      organisationId: org.id,
      action: `booking.${eventKey}`,
      entityType: "Booking",
      entityId: booking.id,
    });

    await recordUsage({
      organisationId: org.id,
      feature: "booking_webhook",
      provider: bookingProviderName,
      metadata: { status: parsed.status },
    });

    await prisma.webhookEvent.update({
      where: { provider_idempotencyKey: { provider: providerLabel, idempotencyKey } },
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

