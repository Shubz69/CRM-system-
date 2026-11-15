import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runAutomations } from "@/services/automations";
import { scheduleFollowUps } from "@/services/followups";

/**
 * What should happen once an AI reply has actually reached the lead. Stored on drafts
 * that wait for approval so Approve & Send does the same follow-through as a direct send.
 */
export type AiReplyFollowThrough = {
  /** Booking link included in the reply — recorded as an offer once delivered. */
  offeredBookingUrl?: string | null;
  attribution?: { source: string; campaign: string | null } | null;
  /** Schedule follow-ups chasing this reply (subject to the workspace's follow-up setting). */
  followUp?: {
    intent?: string | null;
    qualificationStatus?: string | null;
    meetingBooked?: boolean;
  } | null;
};

const DEFAULT_FOLLOW_UP_DELAYS_MINUTES = [60, 1440, 4320];

export async function runAiReplyFollowThrough(input: {
  organisationId: string;
  contactId: string;
  conversationId: string;
  leadId?: string | null;
  plan: AiReplyFollowThrough | null | undefined;
  /** Pass when the caller already loaded the agent configuration. */
  followUpDelaysMinutes?: number[] | null;
  maxFollowUps?: number | null;
  /** Pass when the caller already has the conversation loaded. */
  lastInboundAt?: Date | string | null;
}): Promise<void> {
  const plan = input.plan;
  if (!plan) return;

  if (plan.offeredBookingUrl && input.leadId) {
    // Retries / repeat offers reuse the open offer instead of stacking OFFERED rows.
    const openOffer = await prisma.booking.findFirst({
      where: {
        organisationId: input.organisationId,
        leadId: input.leadId,
        status: BookingStatus.OFFERED,
      },
      select: { id: true },
    });
    if (!openOffer) {
      await prisma.booking.create({
        data: {
          organisationId: input.organisationId,
          contactId: input.contactId,
          conversationId: input.conversationId,
          leadId: input.leadId,
          provider: process.env.BOOKING_PROVIDER || "link",
          status: BookingStatus.OFFERED,
          bookingUrl: plan.offeredBookingUrl,
          attribution: plan.attribution ?? { source: "instagram_manychat", campaign: null },
        },
      });
    }
    await runAutomations({
      organisationId: input.organisationId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      leadId: input.leadId,
      triggerType: "booking_link_sent",
      payload: { bookingUrl: plan.offeredBookingUrl },
    });
  }

  if (plan.followUp) {
    let delays = input.followUpDelaysMinutes ?? null;
    let maxFollowUps = input.maxFollowUps ?? null;
    if (delays === null || maxFollowUps === null) {
      const config = await prisma.agentConfiguration.findFirst({
        where: { organisationId: input.organisationId, isActive: true, isDraft: false },
        orderBy: { updatedAt: "desc" },
        select: { followUpDelaysMinutes: true, maxFollowUps: true },
      });
      if (delays === null && Array.isArray(config?.followUpDelaysMinutes)) {
        delays = (config.followUpDelaysMinutes as unknown[]).filter(
          (d): d is number => typeof d === "number" && d > 0,
        );
      }
      if (maxFollowUps === null) maxFollowUps = config?.maxFollowUps ?? null;
    }
    const max = maxFollowUps ?? 3;
    const lastInboundAt =
      input.lastInboundAt !== undefined
        ? input.lastInboundAt
        : (
            await prisma.conversation.findFirst({
              where: { id: input.conversationId, organisationId: input.organisationId },
              select: { lastInboundAt: true },
            })
          )?.lastInboundAt ?? null;
    await scheduleFollowUps({
      organisationId: input.organisationId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      leadId: input.leadId ?? undefined,
      delaysMinutes: delays && delays.length ? delays : DEFAULT_FOLLOW_UP_DELAYS_MINUTES,
      maxFollowUps: max,
      skipIfAutopilotDisabled: true,
      policyInputs: {
        intent: plan.followUp.intent || "unknown",
        qualificationStatus: plan.followUp.qualificationStatus || "UNKNOWN",
        attemptNumber: 0,
        maxAttempts: max,
        meetingBooked: Boolean(plan.followUp.meetingBooked),
        optedOut: false,
        lastInboundAt,
      },
    });
  }
}
