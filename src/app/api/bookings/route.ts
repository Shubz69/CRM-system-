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

    let conversationId: string | undefined;
    if (body.conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: body.conversationId,
          organisationId: session.organisationId,
          contactId: body.contactId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!conversation) return jsonError("Conversation not found", 404);
      conversationId = conversation.id;
    }

    let leadId: string | undefined;
    if (body.leadId) {
      const lead = await prisma.lead.findFirst({
        where: {
          id: body.leadId,
          organisationId: session.organisationId,
          contactId: body.contactId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!lead) return jsonError("Lead not found", 404);
      leadId = lead.id;
    }

    const bookedStage = await prisma.pipelineStage.findFirst({
      where: {
        slug: "booked",
        pipeline: { organisationId: session.organisationId, isDefault: true },
      },
    });

    const link = await getBookingProvider().createBookingLink({
      organisationId: session.organisationId,
      contactId: body.contactId,
      conversationId,
      leadId,
      bookingUrl: body.bookingUrl ?? process.env.DEFAULT_BOOKING_URL,
    });

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          organisationId: session.organisationId,
          contactId: body.contactId,
          conversationId,
          leadId,
          status: body.status ?? BookingStatus.CREATED,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          bookingUrl: link.url,
          externalId: body.externalId ?? `booking_${Date.now()}`,
          provider: link.provider,
        },
      });

      if (leadId && bookedStage) {
        await tx.lead.updateMany({
          where: { id: leadId, organisationId: session.organisationId },
          data: { stageId: bookedStage.id },
        });
      }

      return created;
    });

    if (conversationId) {
      await cancelPendingFollowUps({
        organisationId: session.organisationId,
        conversationId,
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
