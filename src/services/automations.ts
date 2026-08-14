import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createNotification, notifyOrganisationOwners } from "@/services/notifications";
import { scheduleFollowUps, cancelPendingFollowUps } from "@/services/followups";
import { getBookingProvider } from "@/adapters/booking";
import { getMessagingAdapter } from "@/adapters/messaging";
import { MessageDirection, MessageSenderType, NotificationType } from "@prisma/client";
import { writeAuditLog } from "@/services/audit";

export type AutomationContext = {
  organisationId: string;
  contactId?: string;
  conversationId?: string;
  leadId?: string;
  triggerType: string;
  payload?: Record<string, unknown>;
};

type AutomationAction = {
  type: string;
  value?: string | number | boolean | null;
  tag?: string;
  stageSlug?: string;
  userId?: string;
  message?: string;
  minutes?: number;
};

/**
 * Evaluates active automation rules for a trigger and executes actions in order.
 * Prevents recursive loops by refusing to re-enter the same rule execution stack.
 */
const executing = new Set<string>();

export async function runAutomations(context: AutomationContext): Promise<number> {
  const lockKey = `${context.organisationId}:${context.triggerType}:${context.conversationId ?? context.leadId ?? "none"}`;
  if (executing.has(lockKey)) {
    logger.warn("Automation loop prevented", { lockKey });
    return 0;
  }
  executing.add(lockKey);

  try {
    const rules = await prisma.automationRule.findMany({
      where: {
        organisationId: context.organisationId,
        isActive: true,
        triggerType: context.triggerType,
      },
      orderBy: { createdAt: "asc" },
    });

    let executed = 0;
    for (const rule of rules) {
      const conditions = (rule.conditions ?? {}) as Record<string, unknown>;
      if (!matchesConditions(conditions, context)) {
        continue;
      }

      const actions = Array.isArray(rule.actions) ? (rule.actions as AutomationAction[]) : [];
      try {
        for (const action of actions) {
          await executeAction(action, context);
        }
        await prisma.automationExecution.create({
          data: {
            ruleId: rule.id,
            status: "success",
            context: JSON.parse(JSON.stringify(context)),
            result: { actions: actions.length },
          },
        });
        executed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Automation failed";
        await prisma.automationExecution.create({
          data: {
            ruleId: rule.id,
            status: "failed",
            context: JSON.parse(JSON.stringify(context)),
            error: message,
          },
        });
        await notifyOrganisationOwners({
          organisationId: context.organisationId,
          type: NotificationType.SYSTEM,
          title: "Automation failure",
          body: `Rule "${rule.name}" failed: ${message}`,
          metadata: { ruleId: rule.id },
        });
      }
    }

    return executed;
  } finally {
    executing.delete(lockKey);
  }
}

export function matchesConditions(
  conditions: Record<string, unknown>,
  context: AutomationContext,
): boolean {
  if (conditions.minScore !== undefined && context.payload?.score !== undefined) {
    if (Number(context.payload.score) < Number(conditions.minScore)) return false;
  }
  if (conditions.sentiment !== undefined && context.payload?.sentiment !== undefined) {
    if (String(context.payload.sentiment) !== String(conditions.sentiment)) return false;
  }
  if (conditions.minutes !== undefined && context.payload?.inactiveMinutes !== undefined) {
    if (Number(context.payload.inactiveMinutes) < Number(conditions.minutes)) return false;
  }
  return true;
}

async function executeAction(action: AutomationAction, context: AutomationContext): Promise<void> {
  switch (action.type) {
    case "notify":
    case "notify_team":
      await notifyOrganisationOwners({
        organisationId: context.organisationId,
        type: NotificationType.SYSTEM,
        title: "Automation notification",
        body: action.message || `Triggered by ${context.triggerType}`,
        metadata: { conversationId: context.conversationId, leadId: context.leadId },
      });
      break;

    case "pause_ai":
    case "handover":
      if (context.conversationId) {
        await prisma.conversation.update({
          where: { id: context.conversationId },
          data: { aiPaused: true, handlingMode: "HUMAN", needsHumanReview: true },
        });
      }
      break;

    case "cancel_follow_ups":
      if (context.conversationId) {
        await cancelPendingFollowUps({
          organisationId: context.organisationId,
          conversationId: context.conversationId,
          reason: `Automation: ${context.triggerType}`,
        });
      }
      break;

    case "send_follow_up":
    case "schedule_follow_up":
      if (context.contactId && context.conversationId) {
        await scheduleFollowUps({
          organisationId: context.organisationId,
          contactId: context.contactId,
          conversationId: context.conversationId,
          leadId: context.leadId,
          delaysMinutes: [Number(action.minutes ?? 60)],
          maxFollowUps: 1,
        });
      }
      break;

    case "change_stage":
      if (context.leadId && action.stageSlug) {
        const stage = await prisma.pipelineStage.findFirst({
          where: {
            slug: action.stageSlug,
            pipeline: { organisationId: context.organisationId, isDefault: true },
          },
        });
        if (stage) {
          await prisma.lead.update({
            where: { id: context.leadId },
            data: { stageId: stage.id },
          });
        }
      }
      break;

    case "mark_qualified":
      if (context.leadId) {
        await prisma.lead.update({
          where: { id: context.leadId },
          data: { qualificationStatus: "QUALIFIED" },
        });
      }
      break;

    case "mark_disqualified":
      if (context.leadId) {
        await prisma.lead.update({
          where: { id: context.leadId },
          data: { qualificationStatus: "DISQUALIFIED" },
        });
      }
      break;

    case "add_tag":
      if (action.tag && context.contactId) {
        const tag = await prisma.tag.upsert({
          where: {
            organisationId_name: {
              organisationId: context.organisationId,
              name: action.tag,
            },
          },
          create: { organisationId: context.organisationId, name: action.tag },
          update: {},
        });
        await prisma.contactTag.upsert({
          where: { contactId_tagId: { contactId: context.contactId, tagId: tag.id } },
          create: { contactId: context.contactId, tagId: tag.id },
          update: {},
        });
      }
      break;

    case "assign_owner":
      if (context.conversationId && action.userId) {
        await prisma.conversationAssignment.updateMany({
          where: { conversationId: context.conversationId, active: true },
          data: { active: false },
        });
        await prisma.conversationAssignment.create({
          data: {
            conversationId: context.conversationId,
            userId: String(action.userId),
            active: true,
          },
        });
      }
      break;

    case "send_booking_link":
    case "send_message": {
      if (!context.conversationId || !context.contactId) break;
      const contact = await prisma.contact.findFirst({
        where: { id: context.contactId, organisationId: context.organisationId },
        include: { identifiers: true },
      });
      if (!contact || contact.optedOut) break;
      const conversation = await prisma.conversation.findFirst({
        where: { id: context.conversationId },
      });
      const agent = await prisma.agentConfiguration.findFirst({
        where: { organisationId: context.organisationId, isActive: true },
      });
      let bookingUrl = agent?.bookingUrl || process.env.DEFAULT_BOOKING_URL || "";
      if (action.type === "send_booking_link") {
        const link = await getBookingProvider().createBookingLink({
          organisationId: context.organisationId,
          contactId: context.contactId,
          conversationId: context.conversationId,
          leadId: context.leadId,
          bookingUrl: bookingUrl || undefined,
        });
        bookingUrl = link.url;
        if (!bookingUrl) break;
      }
      const text =
        action.message ||
        (action.type === "send_booking_link"
          ? `You can book a call here: ${bookingUrl}`
          : "Just checking in — happy to help when you are ready.");
      const identifier = contact.identifiers.find((i) => i.channel === "manychat");
      const adapter = getMessagingAdapter(Boolean(process.env.MANYCHAT_API_TOKEN));
      const sendResult = await adapter.sendMessage({
        organisationId: context.organisationId,
        contactExternalId: identifier?.identifier.replace(/^manychat:/, "") || contact.id,
        text,
        threadId: conversation?.externalThreadId ?? undefined,
      });
      if (sendResult.ok && conversation) {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            organisationId: context.organisationId,
            externalId: sendResult.externalMessageId,
            direction: MessageDirection.OUTBOUND,
            senderType: MessageSenderType.SYSTEM,
            body: text,
            deliveryStatus: "sent",
          },
        });
      }
      break;
    }

    case "create_task":
      await createNotification({
        organisationId: context.organisationId,
        type: NotificationType.TASK,
        title: "Task from automation",
        body: action.message || "Follow up with this lead.",
        metadata: {
          conversationId: context.conversationId,
          leadId: context.leadId,
        },
      });
      break;

    default:
      logger.warn("Unknown automation action", { type: action.type });
  }

  await writeAuditLog({
    organisationId: context.organisationId,
    action: `automation.action.${action.type}`,
    entityType: "Automation",
    entityId: context.conversationId || context.leadId,
    metadata: { trigger: context.triggerType },
  });
}
