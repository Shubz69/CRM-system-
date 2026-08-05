import { FollowUpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { writeAuditLog } from "@/services/audit";

export async function scheduleFollowUps(input: {
  organisationId: string;
  contactId: string;
  conversationId: string;
  leadId?: string;
  delaysMinutes: number[];
  maxFollowUps: number;
}): Promise<number> {
  await cancelPendingFollowUps({
    conversationId: input.conversationId,
    reason: "Rescheduled after new activity",
  });

  const delays = input.delaysMinutes.slice(0, input.maxFollowUps);
  const now = Date.now();
  let created = 0;

  for (let i = 0; i < delays.length; i += 1) {
    const minutes = delays[i] ?? 60;
    await prisma.followUp.create({
      data: {
        organisationId: input.organisationId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        leadId: input.leadId,
        attemptNumber: i + 1,
        scheduledFor: new Date(now + minutes * 60_000),
        status: FollowUpStatus.SCHEDULED,
        messageBody: `Follow-up #${i + 1}: checking in after inactivity`,
      },
    });
    created += 1;
  }

  await writeAuditLog({
    organisationId: input.organisationId,
    action: "followups.scheduled",
    entityType: "Conversation",
    entityId: input.conversationId,
    metadata: { count: created, delays },
  });

  logger.info("Follow-ups scheduled", {
    conversationId: input.conversationId,
    count: created,
  });

  return created;
}

export async function cancelPendingFollowUps(input: {
  conversationId: string;
  reason: string;
}): Promise<number> {
  const result = await prisma.followUp.updateMany({
    where: {
      conversationId: input.conversationId,
      status: FollowUpStatus.SCHEDULED,
    },
    data: {
      status: FollowUpStatus.CANCELLED,
      cancelReason: input.reason,
    },
  });
  return result.count;
}

export async function cancelFollowUpsOnOptOut(contactId: string): Promise<number> {
  const result = await prisma.followUp.updateMany({
    where: {
      contactId,
      status: FollowUpStatus.SCHEDULED,
    },
    data: {
      status: FollowUpStatus.CANCELLED,
      cancelReason: "Contact opted out",
    },
  });
  return result.count;
}
