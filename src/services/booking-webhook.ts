import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { BookingStatus } from "@prisma/client";
import { getBookingProvider } from "@/adapters/booking";
import { assertProductionSecretsConfigured, getEnv } from "@/lib/env";
import {
  assertWebhookTimestampFresh,
  readWebhookTimestampHeader,
  WebhookReplayError,
} from "@/lib/webhook-replay";
import { prisma } from "@/lib/db";
import { cancelPendingFollowUps } from "@/services/followups";
import { writeAuditLog } from "@/services/audit";
import { notifyOnBooking } from "@/services/notifications";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { runAutomations } from "@/services/automations";
import { recordUsage } from "@/services/usage";
import { recordCrmActivity } from "@/services/crm-activity";
import {
  matchesSharedBookingSecret,
  verifyBookingWebhookSecret,
} from "@/services/booking-secrets";

function bookingActivityTitle(status: string): string {
  switch (status) {
    case "CREATED":
      return "Meeting booked";
    case "RESCHEDULED":
      return "Meeting rescheduled";
    case "CANCELLED":
      return "Booking cancelled";
    case "ATTENDED":
      return "Attended meeting";
    case "NO_SHOW":
      return "Missed meeting (no-show)";
    default:
      return "Booking updated";
  }
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

type WebhookEventKey = { provider: string; idempotencyKey: string };

/** Never leave an event PROCESSING: the next delivery and operators must see why it stopped. */
async function settleWebhookEvent(
  key: WebhookEventKey,
  status: "FAILED" | "IGNORED",
  error: string,
): Promise<void> {
  await prisma.webhookEvent
    .update({
      where: { provider_idempotencyKey: key },
      data: { status, error: error.slice(0, 1000), processedAt: new Date() },
    })
    .catch((updateError: unknown) => {
      logger.warn("Booking webhook event status update failed", {
        message: updateError instanceof Error ? updateError.message : "unknown",
      });
    });
}

/** Shared booking webhook processor used by generic + provider-specific routes. */
export async function handleBookingWebhook(
  req: NextRequest,
  options?: { providerLabel?: string; normalizePayload?: (raw: unknown) => unknown },
) {
  let recordedEvent: WebhookEventKey | null = null;
  try {
    assertProductionSecretsConfigured();
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    const providerLabel = options?.providerLabel || "booking";
    if (!rateLimit(`${providerLabel}:${ip}`, 60, 60_000)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    try {
      assertWebhookTimestampFresh({
        timestamp: readWebhookTimestampHeader(req.headers),
      });
    } catch (error) {
      if (error instanceof WebhookReplayError) {
        return Response.json({ error: error.message }, { status: 401 });
      }
      throw error;
    }

    const secret =
      req.headers.get("x-booking-secret") ||
      req.headers.get("x-calendly-secret") ||
      req.headers.get("x-cal-secret") ||
      "";
    if (!secret) {
      return Response.json({ error: "Invalid webhook secret" }, { status: 401 });
    }

    const rawIncoming = await req.json();
    const rawBody = options?.normalizePayload
      ? options.normalizePayload(rawIncoming)
      : rawIncoming;

    const provider = getBookingProvider();
    const parsed = provider.parseWebhook(rawBody);

    const organisationIdFromBody =
      rawBody && typeof rawBody === "object" && "organisationId" in rawBody
        ? String((rawBody as { organisationId?: unknown }).organisationId || "")
        : "";

    const org =
      parsed && organisationIdFromBody
        ? await prisma.organisation.findFirst({
            where: { id: organisationIdFromBody, deletedAt: null },
          })
        : null;

    if (!parsed || !org) {
      // Authenticate before explaining what's wrong with the payload: without a workspace
      // the only secret that can be checked is the shared one.
      if (!matchesSharedBookingSecret(secret)) {
        return Response.json({ error: "Invalid webhook secret" }, { status: 401 });
      }
      return Response.json(
        {
          error: parsed
            ? "organisationId required (no silent first-org fallback)"
            : "Invalid booking webhook payload",
        },
        { status: 400 },
      );
    }

    // The secret must belong to the workspace this booking is for. A workspace with its own
    // secret no longer accepts the shared one, so another tenant can't write into it.
    const secretCheck = await verifyBookingWebhookSecret({
      organisationId: org.id,
      presented: secret,
    });
    if (!secretCheck.ok) {
      return Response.json({ error: secretCheck.reason }, { status: 401 });
    }
    if (secretCheck.source === "global") {
      logger.warn("Booking webhook authorised with the shared secret", {
        organisationId: org.id,
      });
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
    recordedEvent = { provider: providerLabel, idempotencyKey };

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
      await settleWebhookEvent(recordedEvent, "IGNORED", "Contact not found for booking");
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
        : getEnv().BOOKING_PROVIDER === "mock"
          ? "mock"
          : "link";

    const bookingKey = {
      organisationId: org.id,
      provider: bookingProviderName,
      externalId: parsed.externalId,
    };
    const alreadyTracked = await prisma.booking.findUnique({
      where: { organisationId_provider_externalId: bookingKey },
      select: { id: true },
    });
    // The AI records an OFFERED booking (no externalId) when it sends the link. Confirm that
    // row in place — creating a second row and then stamping the same externalId onto the
    // offer violated the (organisationId, provider, externalId) unique index on every retry.
    const offered = alreadyTracked
      ? null
      : await prisma.booking.findFirst({
          where: {
            organisationId: org.id,
            contactId: contact.id,
            status: BookingStatus.OFFERED,
            externalId: null,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });

    const booking = offered
      ? await prisma.booking.update({
          where: { id: offered.id },
          data: {
            provider: bookingProviderName,
            externalId: parsed.externalId,
            status: parsed.status as BookingStatus,
            scheduledAt: parsed.scheduledAt ?? null,
            ...(bookingUrl ? { bookingUrl } : {}),
          },
        })
      : await prisma.booking.upsert({
          where: { organisationId_provider_externalId: bookingKey },
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

    // Timeline entry once the event is fully processed (a redelivery returns early above).
    // Best-effort: never changes the webhook's response.
    await recordCrmActivity({
      organisationId: org.id,
      kind: "booking",
      title: bookingActivityTitle(parsed.status),
      contactId: contact.id,
      leadId: lead?.id ?? booking.leadId ?? null,
      metadata: {
        bookingId: booking.id,
        status: parsed.status,
        scheduledAt:
          parsed.scheduledAt instanceof Date && !Number.isNaN(parsed.scheduledAt.getTime())
            ? parsed.scheduledAt.toISOString()
            : null,
        provider: bookingProviderName,
        movedToStage: lead && targetStage ? targetStage.name : null,
      },
    });

    return Response.json({ ok: true, bookingId: booking.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    logger.error("Booking webhook failed", { message });
    if (recordedEvent) {
      await settleWebhookEvent(recordedEvent, "FAILED", message);
    }
    return Response.json({ error: "Booking webhook failed" }, { status: 500 });
  }
}

