import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { z } from "zod";
import { BookingStatus } from "@prisma/client";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/db";
import { cancelPendingFollowUps } from "@/services/followups";
import { writeAuditLog } from "@/services/audit";
import { logger } from "@/lib/logger";

const bookingWebhookSchema = z.object({
  organisationId: z.string().optional(),
  event: z.enum(["created", "rescheduled", "cancelled", "attended", "no_show"]),
  externalId: z.string(),
  contactEmail: z.string().email().optional(),
  contactExternalId: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
  bookingUrl: z.string().optional(),
});

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

const statusMap: Record<string, BookingStatus> = {
  created: BookingStatus.CREATED,
  rescheduled: BookingStatus.RESCHEDULED,
  cancelled: BookingStatus.CANCELLED,
  attended: BookingStatus.ATTENDED,
  no_show: BookingStatus.NO_SHOW,
};

export async function POST(req: NextRequest) {
  try {
    const env = getEnv();
    const secret = req.headers.get("x-booking-secret") || "";
    if (!safeEqual(secret, env.BOOKING_WEBHOOK_SECRET)) {
      return Response.json({ error: "Invalid webhook secret" }, { status: 401 });
    }

    const body = bookingWebhookSchema.parse(await req.json());
    const org =
      (body.organisationId &&
        (await prisma.organisation.findUnique({ where: { id: body.organisationId } }))) ||
      (await prisma.organisation.findFirst({ where: { deletedAt: null } }));

    if (!org) return Response.json({ error: "Organisation not found" }, { status: 400 });

    const idempotencyKey = createHash("sha256")
      .update(`booking:${body.event}:${body.externalId}`)
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
        eventType: body.event,
        idempotencyKey,
        payload: body,
        status: "PROCESSING",
      },
      update: { status: "PROCESSING", payload: body },
    });

    let contact = body.contactEmail
      ? await prisma.contact.findFirst({
          where: { organisationId: org.id, email: body.contactEmail },
        })
      : null;

    if (!contact && body.contactExternalId) {
      const ident = await prisma.contactIdentifier.findUnique({
        where: {
          channel_identifier: {
            channel: "manychat",
            identifier: `manychat:${body.contactExternalId}`,
          },
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

    const booking = await prisma.booking.upsert({
      where: {
        organisationId_provider_externalId: {
          organisationId: org.id,
          provider: "link",
          externalId: body.externalId,
        },
      },
      create: {
        organisationId: org.id,
        contactId: contact.id,
        conversationId: lead?.conversationId ?? undefined,
        leadId: lead?.id,
        provider: "link",
        externalId: body.externalId,
        status: statusMap[body.event],
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        bookingUrl: body.bookingUrl,
      },
      update: {
        status: statusMap[body.event],
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        bookingUrl: body.bookingUrl,
      },
    });

    if (lead?.conversationId && ["created", "rescheduled"].includes(body.event)) {
      await cancelPendingFollowUps({
        conversationId: lead.conversationId,
        reason: "Booking webhook update",
      });
    }

    if (lead && bookedStage && body.event === "created") {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { stageId: bookedStage.id },
      });
    }

    await writeAuditLog({
      organisationId: org.id,
      action: `booking.${body.event}`,
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
