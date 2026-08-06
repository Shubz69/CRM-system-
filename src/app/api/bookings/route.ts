import { NextRequest } from "next/server";
import { z } from "zod";
import { BookingStatus } from "@prisma/client";
import { getBookingProvider } from "@/adapters/booking";
import { prisma } from "@/lib/db";
import { requirePermission, jsonError } from "@/lib/session";
import { cancelPendingFollowUps } from "@/services/followups";
import { writeAuditLog } from "@/services/audit";
import { notifyOnBooking } from "@/services/notifications";

const createSchema = z.object({
  contactId: z.string(),
  conversationId: z.string().optional(),
  leadId: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
  bookingUrl: z.string().url().optional(),
  externalId: z.string().optional(),
  status: z.nativeEnum(BookingStatus).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("leads:write");
    const body = createSchema.parse(await req.json());

    const contact = await prisma.contact.findFirst({
      where: { id: body.contactId, organisationId: session.organisationId },
    });
    if (!contact) return jsonError("Contact not found", 404);

    const bookedStage = await prisma.pipelineStage.findFirst({
      where: {
        slug: "booked",
        pipeline: { organisationId: session.organisationId, isDefault: true },
      },
    });

    const link = await getBookingProvider().createBookingLink({
      organisationId: session.organisationId,
      contactId: body.contactId,
      conversationId: body.conversationId,
      leadId: body.leadId,
      bookingUrl: body.bookingUrl ?? process.env.DEFAULT_BOOKING_URL,
    });

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          organisationId: session.organisationId,
          contactId: body.contactId,
          conversationId: body.conversationId,
          leadId: body.leadId,
          status: body.status ?? BookingStatus.CREATED,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          bookingUrl: link.url,
          externalId: body.externalId ?? `booking_${Date.now()}`,
          provider: link.provider,
        },
      });

      if (body.leadId && bookedStage) {
        await tx.lead.update({
          where: { id: body.leadId },
          data: { stageId: bookedStage.id },
        });
      }

      return created;
    });

    if (body.conversationId) {
      await cancelPendingFollowUps({
        conversationId: body.conversationId,
        reason: "Booking confirmed",
      });
    }

    await notifyOnBooking({
      organisationId: session.organisationId,
      bookingId: booking.id,
      event: "created",
    });

    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "booking.created",
      entityType: "Booking",
      entityId: booking.id,
    });

    return Response.json({ booking });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}

export async function GET() {
  try {
    const session = await requirePermission("leads:read");
    const bookings = await prisma.booking.findMany({
      where: { organisationId: session.organisationId },
      include: { contact: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return Response.json({ bookings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
