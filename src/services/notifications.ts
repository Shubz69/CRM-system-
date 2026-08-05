import { NotificationType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export async function createNotification(input: {
  organisationId: string;
  userId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const notification = await prisma.notification.create({
    data: {
      organisationId: input.organisationId,
      userId: input.userId ?? undefined,
      type: input.type,
      title: input.title,
      body: input.body,
      metadata: JSON.parse(JSON.stringify(input.metadata ?? {})),
    },
  });

  logger.info("Notification created", {
    organisationId: input.organisationId,
    type: input.type,
    notificationId: notification.id,
  });

  return notification.id;
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
