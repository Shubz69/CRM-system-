import { FollowUpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { writeAuditLog } from "@/services/audit";
import { capabilityAllowsAuto, parseAutopilotConfig } from "@/services/autopilot";
import {
  planFollowUpSchedule,
  type FollowUpPolicyInput,
} from "@/services/messaging/followup-policy";

const FOLLOW_UP_TEMPLATES = [
  "Just checking in — would it help if I answered any questions or shared the next step?",
  "Following up in case this got buried. I can clarify anything that is holding you back.",
  "One last check-in from me. Reply whenever the timing is right and we can pick this back up.",
];

export async function scheduleFollowUps(input: {
  organisationId: string;
  contactId: string;
  conversationId: string;
  leadId?: string;
  delaysMinutes?: number[];
  maxFollowUps?: number;
  policyInputs?: FollowUpPolicyInput;
  /** Alias retained for callers that name the policy object directly. */
  policy?: FollowUpPolicyInput;
  skipIfAutopilotDisabled?: boolean;
}): Promise<number> {
  if (input.skipIfAutopilotDisabled) {
    const organisation = await prisma.organisation.findUnique({
      where: { id: input.organisationId },
      select: { autopilotConfig: true },
    });
    if (
      !organisation ||
      !capabilityAllowsAuto(parseAutopilotConfig(organisation.autopilotConfig), "followUps")
    ) {
      return 0;
    }
  }

  await cancelPendingFollowUps({
    organisationId: input.organisationId,
    conversationId: input.conversationId,
    reason: "Rescheduled after new activity",
  });

  const policy = input.policyInputs ?? input.policy;
  const plannedDelays = policy ? planFollowUpSchedule(policy) : (input.delaysMinutes ?? []);
  const maxFollowUps = input.maxFollowUps ?? policy?.maxAttempts ?? plannedDelays.length;
  const delays = plannedDelays.slice(0, Math.max(0, maxFollowUps));
  const startingAttempt = policy ? Math.max(0, Math.floor(policy.attemptNumber)) : 0;
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
        attemptNumber: startingAttempt + i + 1,
        scheduledFor: new Date(now + minutes * 60_000),
        status: FollowUpStatus.SCHEDULED,
        messageBody:
          FOLLOW_UP_TEMPLATES[Math.min(i, FOLLOW_UP_TEMPLATES.length - 1)] ??
          FOLLOW_UP_TEMPLATES[0],
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
  organisationId: string;
  conversationId: string;
  reason: string;
}): Promise<number> {
  const result = await prisma.followUp.updateMany({
    where: {
      organisationId: input.organisationId,
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

export async function cancelFollowUpsOnOptOut(input: {
  organisationId: string;
  contactId: string;
}): Promise<number> {
  const result = await prisma.followUp.updateMany({
    where: {
      organisationId: input.organisationId,
      contactId: input.contactId,
      status: FollowUpStatus.SCHEDULED,
    },
    data: {
      status: FollowUpStatus.CANCELLED,
      cancelReason: "Contact opted out",
    },
  });
  return result.count;
}
