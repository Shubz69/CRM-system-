import { NotificationType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Create a notification. Without a `userId` it is for the whole workspace: one row per
 * active member, so each person has their own read state (a shared row meant one
 * person's "mark all read" hid it for everyone). Returns the ids of the rows created.
 */
export async function createNotification(input: {
  organisationId: string;
  userId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}): Promise<string[]> {
  const recipients = input.userId
    ? [input.userId]
    : (
        await prisma.organisationMember.findMany({
          where: {
            organisationId: input.organisationId,
            user: { deletedAt: null, isActive: true, isSuspended: false },
          },
          select: { userId: true },
        })
      ).map((m) => m.userId);
  if (recipients.length === 0) return [];

  const metadata = JSON.parse(JSON.stringify(input.metadata ?? {}));
  const created = await prisma.notification.createManyAndReturn({
    data: recipients.map((userId) => ({
      organisationId: input.organisationId,
      userId,
      type: input.type,
      title: input.title,
      body: input.body,
      metadata,
    })),
    select: { id: true },
  });

  logger.info("Notification created", {
    organisationId: input.organisationId,
    type: input.type,
    notificationIds: created.map((n) => n.id),
    recipients: created.length,
  });

  return created.map((n) => n.id);
}

export async function notifyOrganisationOwners(input: {
  organisationId: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}): Promise<number> {
  const owners = await prisma.organisationMember.findMany({
    where: {
      organisationId: input.organisationId,
      role: { in: ["OWNER", "ADMINISTRATOR", "MANAGER"] },
    },
    select: { userId: true },
  });

  for (const owner of owners) {
    await createNotification({
      ...input,
      userId: owner.userId,
    });
  }

  return owners.length;
}

export async function notifyOnHandover(input: {
  organisationId: string;
  conversationId: string;
  reason: string | null;
}): Promise<void> {
  await notifyOrganisationOwners({
    organisationId: input.organisationId,
    type: NotificationType.HANDOVER,
    title: "Human handover required",
    body: input.reason || "A conversation was flagged for human review.",
    metadata: { conversationId: input.conversationId },
  });
}

export async function notifyOnHighScore(input: {
  organisationId: string;
  leadId: string;
  score: number;
}): Promise<void> {
  if (input.score < 70) return;
  await notifyOrganisationOwners({
    organisationId: input.organisationId,
    type: NotificationType.HIGH_SCORE,
    title: `High-score lead (${input.score})`,
    body: "A lead scored above the attention threshold.",
    metadata: { leadId: input.leadId, score: input.score },
  });
}

export async function notifyOnNegativeSentiment(input: {
  organisationId: string;
  conversationId: string;
}): Promise<void> {
  await notifyOrganisationOwners({
    organisationId: input.organisationId,
    type: NotificationType.NEGATIVE_SENTIMENT,
    title: "Negative sentiment detected",
    body: "A conversation may need human attention.",
    metadata: { conversationId: input.conversationId },
  });
}

export async function notifyOnBooking(input: {
  organisationId: string;
  bookingId: string;
  event: string;
}): Promise<void> {
  await notifyOrganisationOwners({
    organisationId: input.organisationId,
    type: NotificationType.BOOKING,
    title: `Booking ${input.event}`,
    body: `A booking was ${input.event}.`,
    metadata: { bookingId: input.bookingId },
  });
}
