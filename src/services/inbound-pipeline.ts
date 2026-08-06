import {
  BookingStatus,
  HandlingMode,
  MessageDirection,
  MessageSenderType,
  QualificationStatus,
  WebhookProcessingStatus,
} from "@prisma/client";
import { analyseWithValidation, buildAgentSystemPrompt, getAiProvider } from "@/adapters/ai";
import { getBookingProvider } from "@/adapters/booking";
import { getMessagingAdapter } from "@/adapters/messaging";
import { hashForIdempotency } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { evaluateMessagingWindow, openMessagingWindows } from "@/lib/messaging-window";
import type { InboundMessageInput } from "@/schemas/webhook";
import { writeAuditLog } from "@/services/audit";
import { upsertCampaignAttribution } from "@/services/attribution";
import { runAutomations } from "@/services/automations";
import { cancelFollowUpsOnOptOut, cancelPendingFollowUps, scheduleFollowUps } from "@/services/followups";
import { retrieveRelevantKnowledge } from "@/services/knowledge";
import {
  notifyOnHandover,
  notifyOnHighScore,
  notifyOnNegativeSentiment,
  notifyOrganisationOwners,
} from "@/services/notifications";
import { applyOptOut, detectOptOut, DEFAULT_OPT_OUT_KEYWORDS } from "@/services/opt-out";
import { syncQualificationAnswers } from "@/services/qualification";
import { calculateLeadScore } from "@/services/scoring";
import { recordUsage } from "@/services/usage";
import { NotificationType } from "@prisma/client";

function mapQualificationStatus(status: string): QualificationStatus {
  switch (status) {
    case "qualified":
      return QualificationStatus.QUALIFIED;
    case "disqualified":
      return QualificationStatus.DISQUALIFIED;
    case "qualifying":
      return QualificationStatus.QUALIFYING;
    default:
      return QualificationStatus.UNKNOWN;
  }
}

async function getDefaultStage(organisationId: string, slug: string) {
  const pipeline = await prisma.pipeline.findFirst({
    where: { organisationId, isDefault: true },
    include: { stages: true },
  });
  if (!pipeline) return null;
  return (
    pipeline.stages.find((s) => s.slug === slug) ??
    pipeline.stages.sort((a, b) => a.position - b.position)[0] ??
    null
  );
}

export type InboundProcessResult = {
  duplicate: boolean;
  webhookEventId: string;
  contactId?: string;
  conversationId?: string;
  messageId?: string;
  leadId?: string;
  aiReplySent?: boolean;
  needsHumanReview?: boolean;
  outboundMessageId?: string;
  optedOut?: boolean;
  analysis?: Record<string, unknown>;
};

export async function processInboundMessage(
  input: InboundMessageInput,
  options?: { provider?: string; rawPayload?: unknown },
): Promise<InboundProcessResult> {
  const provider = options?.provider ?? "simulator";
  const idempotencyKey =
    input.idempotencyKey ||
    hashForIdempotency(
      JSON.stringify({
        org: input.organisationId,
        contact: input.contact.externalId,
        message: input.message.externalId || input.message.text,
        thread: input.threadId,
      }),
    );

  const existing = await prisma.webhookEvent.findUnique({
    where: {
      provider_idempotencyKey: {
        provider,
        idempotencyKey,
      },
    },
  });

  if (existing && (existing.status === WebhookProcessingStatus.PROCESSED || existing.status === WebhookProcessingStatus.DUPLICATE)) {
    return { duplicate: true, webhookEventId: existing.id };
  }

  const webhookEvent =
    existing ??
    (await prisma.webhookEvent.create({
      data: {
        organisationId: input.organisationId,
        provider,
        eventType: "inbound_message",
        idempotencyKey,
        payload: (options?.rawPayload as object) ?? input,
        status: WebhookProcessingStatus.RECEIVED,
      },
    }));

  await prisma.webhookEvent.update({
    where: { id: webhookEvent.id },
    data: { status: WebhookProcessingStatus.PROCESSING },
  });

  try {
    const result = await prisma.$transaction(async (tx) => {
      let channel = await tx.messagingChannel.findFirst({
        where: {
          organisationId: input.organisationId,
          provider: "manychat",
          ...(input.channelExternalId ? { externalId: input.channelExternalId } : {}),
        },
      });

      if (!channel) {
        channel = await tx.messagingChannel.create({
          data: {
            organisationId: input.organisationId,
            provider: "manychat",
            externalId: input.channelExternalId ?? "default",
            displayName: "Instagram via ManyChat",
            instagramUsername: "demo_account",
          },
        });
      }

      const identifierValue = `manychat:${input.contact.externalId}`;
      const contactIdentifier = await tx.contactIdentifier.findUnique({
        where: {
          organisationId_channel_identifier: {
            organisationId: input.organisationId,
            channel: "manychat",
            identifier: identifierValue,
          },
        },
        include: { contact: true },
      });

      let contact = contactIdentifier?.contact ?? null;

      if (!contact && input.contact.email) {
        contact = await tx.contact.findFirst({
          where: {
            organisationId: input.organisationId,
            email: input.contact.email,
            deletedAt: null,
          },
        });
      }

      if (!contact && input.contact.phone) {
        contact = await tx.contact.findFirst({
          where: {
            organisationId: input.organisationId,
            phone: input.contact.phone,
            deletedAt: null,
          },
        });
      }

      if (!contact) {
        contact = await tx.contact.create({
          data: {
            organisationId: input.organisationId,
            messagingChannelId: channel.id,
            fullName:
              input.contact.fullName ||
              input.contact.instagramUsername ||
              `Lead ${input.contact.externalId}`,
            instagramUsername: input.contact.instagramUsername,
            email: input.contact.email || null,
            phone: input.contact.phone || null,
            leadSource: input.leadSource ?? "instagram",
            campaignSource: input.campaignSource,
            identifiers: {
              create: {
                organisationId: input.organisationId,
                channel: "manychat",
                identifier: identifierValue,
              },
            },
          },
        });
      } else {
        contact = await tx.contact.update({
          where: { id: contact.id },
          data: {
            lastContactAt: new Date(),
            fullName: input.contact.fullName || contact.fullName,
            instagramUsername: input.contact.instagramUsername || contact.instagramUsername,
            email: input.contact.email || contact.email,
            phone: input.contact.phone || contact.phone,
            campaignSource: input.campaignSource || contact.campaignSource,
          },
        });

        if (!contactIdentifier) {
          await tx.contactIdentifier.create({
            data: {
              organisationId: input.organisationId,
              contactId: contact.id,
              channel: "manychat",
              identifier: identifierValue,
            },
          });
        }
      }

      const threadKey = input.threadId || `manychat:${input.contact.externalId}`;
      let conversation = await tx.conversation.findFirst({
        where: {
          organisationId: input.organisationId,
          OR: [{ externalThreadId: threadKey }, { contactId: contact.id, deletedAt: null }],
        },
        orderBy: { updatedAt: "desc" },
      });

      if (!conversation) {
        const windows = openMessagingWindows();
        conversation = await tx.conversation.create({
          data: {
            organisationId: input.organisationId,
            contactId: contact.id,
            messagingChannelId: channel.id,
            externalThreadId: threadKey,
            handlingMode: HandlingMode.AI,
            unreadCount: 1,
            lastMessageAt: windows.lastInboundAt,
            lastMessagePreview: input.message.text.slice(0, 140),
            lastInboundAt: windows.lastInboundAt,
            messagingWindowExpiresAt: windows.messagingWindowExpiresAt,
            humanMessagingWindowExpiresAt: windows.humanMessagingWindowExpiresAt,
          },
        });
      } else {
        const windows = openMessagingWindows();
        conversation = await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            unreadCount: { increment: 1 },
            lastMessageAt: windows.lastInboundAt,
            lastMessagePreview: input.message.text.slice(0, 140),
            externalThreadId: conversation.externalThreadId || threadKey,
            lastInboundAt: windows.lastInboundAt,
            messagingWindowExpiresAt: windows.messagingWindowExpiresAt,
            humanMessagingWindowExpiresAt: windows.humanMessagingWindowExpiresAt,
          },
        });
      }

      const inboundMessage = await tx.message.create({
        data: {
          conversationId: conversation.id,
          organisationId: input.organisationId,
          externalId: input.message.externalId || `in_${idempotencyKey.slice(0, 24)}`,
          direction: MessageDirection.INBOUND,
          senderType: MessageSenderType.CONTACT,
          body: input.message.text,
          rawPayload: (options?.rawPayload as object) ?? undefined,
          sentAt: input.message.sentAt ? new Date(input.message.sentAt) : new Date(),
        },
      });

      const pipeline = await tx.pipeline.findFirst({
        where: { organisationId: input.organisationId, isDefault: true },
        include: { stages: true },
      });
      const newStage =
        pipeline?.stages.find((s) => s.slug === "new") ??
        pipeline?.stages.sort((a, b) => a.position - b.position)[0];

      let lead = await tx.lead.findFirst({
        where: {
          organisationId: input.organisationId,
          conversationId: conversation.id,
          deletedAt: null,
        },
      });

      if (!lead) {
        lead = await tx.lead.create({
          data: {
            organisationId: input.organisationId,
            contactId: contact.id,
            conversationId: conversation.id,
            pipelineId: pipeline?.id,
            stageId: newStage?.id,
            qualificationStatus: QualificationStatus.UNKNOWN,
          },
        });
      }

      return { contact, conversation, inboundMessage, lead, channel };
    });

    const agentConfig = await prisma.agentConfiguration.findFirst({
      where: { organisationId: input.organisationId, isActive: true, isDraft: false },
      orderBy: { updatedAt: "desc" },
    });

    const optOutKeywords = Array.isArray(agentConfig?.optOutKeywords)
      ? (agentConfig.optOutKeywords as string[])
      : DEFAULT_OPT_OUT_KEYWORDS;

    if (detectOptOut(input.message.text, optOutKeywords) || result.contact.optedOut) {
      if (!result.contact.optedOut) {
        await applyOptOut({
          organisationId: input.organisationId,
          contactId: result.contact.id,
          source: "inbound_keyword",
          reason: input.message.text.slice(0, 200),
        });
      } else {
        await cancelFollowUpsOnOptOut(result.contact.id);
      }

      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
      });

      await runAutomations({
        organisationId: input.organisationId,
        contactId: result.contact.id,
        conversationId: result.conversation.id,
        leadId: result.lead.id,
        triggerType: "contact_opted_out",
      });

      return {
        duplicate: false,
        webhookEventId: webhookEvent.id,
        contactId: result.contact.id,
        conversationId: result.conversation.id,
        messageId: result.inboundMessage.id,
        leadId: result.lead.id,
        aiReplySent: false,
        optedOut: true,
      };
    }

    await cancelPendingFollowUps({
      conversationId: result.conversation.id,
      reason: "Lead replied",
    });

    await runAutomations({
      organisationId: input.organisationId,
      contactId: result.contact.id,
      conversationId: result.conversation.id,
      leadId: result.lead.id,
      triggerType: "lead_replied",
    });

    await runAutomations({
      organisationId: input.organisationId,
      contactId: result.contact.id,
      conversationId: result.conversation.id,
      leadId: result.lead.id,
      triggerType: "new_inbound_message",
      payload: { text: input.message.text },
    });

    const aiEnabled =
      !result.conversation.aiPaused && result.conversation.handlingMode === HandlingMode.AI;

    if (!aiEnabled) {
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
      });
      return {
        duplicate: false,
        webhookEventId: webhookEvent.id,
        contactId: result.contact.id,
        conversationId: result.conversation.id,
        messageId: result.inboundMessage.id,
        leadId: result.lead.id,
        aiReplySent: false,
      };
    }

    const knowledge = await retrieveRelevantKnowledge({
      organisationId: input.organisationId,
      query: input.message.text,
    });

    const recentMessages = await prisma.message.findMany({
      where: { conversationId: result.conversation.id },
      orderBy: { sentAt: "asc" },
      take: 30,
    });

    const transcript = recentMessages.map((m) => `${m.senderType}: ${m.body}`).join("\n");
    const providerClient = getAiProvider(agentConfig?.aiProvider);
    const systemPrompt = buildAgentSystemPrompt({
      brandTone: agentConfig?.brandTone ?? "professional, helpful, concise",
      formality: agentConfig?.formality ?? "professional",
      responseLength: agentConfig?.responseLength ?? "medium",
      emojiUsage: agentConfig?.emojiUsage ?? "minimal",
      restrictedTopics: agentConfig?.restrictedTopics ?? [],
      bookingUrl: agentConfig?.bookingUrl,
      qualificationQuestions: agentConfig?.qualificationQuestions ?? [],
      systemPromptExtra: agentConfig?.systemPromptExtra,
    });

    const analysisStarted = Date.now();
    const analysisResult = await analyseWithValidation(providerClient, {
      model: agentConfig?.model,
      systemPrompt,
      conversationTranscript: transcript,
      knowledgeContext: knowledge.chunks.join("\n\n"),
      leadMessage: input.message.text,
    });
    const analysisLatencyMs = Date.now() - analysisStarted;

    if (!analysisResult.ok) {
      await prisma.conversation.update({
        where: { id: result.conversation.id },
        data: {
          needsHumanReview: true,
          handlingMode: HandlingMode.HUMAN,
          aiPaused: true,
          handoffReason: analysisResult.reason,
        },
      });
      await prisma.knowledgeRecommendation.create({
        data: {
          organisationId: input.organisationId,
          conversationId: result.conversation.id,
          question: input.message.text.slice(0, 280),
          reason: `AI validation failed: ${analysisResult.reason}`,
          status: "NEW",
        },
      });
      await writeAuditLog({
        organisationId: input.organisationId,
        action: "ai.validation_failed",
        entityType: "Conversation",
        entityId: result.conversation.id,
        metadata: { reason: analysisResult.reason, latencyMs: analysisLatencyMs },
      });
      await notifyOrganisationOwners({
        organisationId: input.organisationId,
        type: NotificationType.AI_FAILURE,
        title: "AI response validation failed",
        body: "Conversation flagged for human review.",
        metadata: { conversationId: result.conversation.id },
      });
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
      });
      return {
        duplicate: false,
        webhookEventId: webhookEvent.id,
        contactId: result.contact.id,
        conversationId: result.conversation.id,
        messageId: result.inboundMessage.id,
        leadId: result.lead.id,
        aiReplySent: false,
        needsHumanReview: true,
      };
    }

    const analysis = analysisResult.analysis;
    const threshold = agentConfig?.confidenceThreshold ?? 0.65;
    const forceHandover = analysis.should_handover || analysis.confidence < threshold;

    await syncQualificationAnswers({
      organisationId: input.organisationId,
      leadId: result.lead.id,
      answers: analysis.answers_collected,
    });

    const score = calculateLeadScore({
      analysis,
      rules: (agentConfig?.scoringRules as { weights?: Record<string, number> }) ?? undefined,
      messageCount: recentMessages.length,
    });

    let stageSlug = "engaged";
    if (analysis.qualification_status === "qualified") stageSlug = "qualified";
    if (analysis.qualification_status === "disqualified") stageSlug = "disqualified";
    if (analysis.recommended_next_action === "send_booking_link") stageSlug = "booking_offered";
    if (forceHandover) stageSlug = "qualifying";

    const stage = await getDefaultStage(input.organisationId, stageSlug);

    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: result.conversation.id },
        data: {
          summary: analysis.conversation_summary,
          intent: analysis.intent,
          sentiment: analysis.sentiment,
          needsHumanReview: forceHandover,
          handlingMode: forceHandover ? HandlingMode.HUMAN : HandlingMode.AI,
          aiPaused: forceHandover,
          handoffReason: forceHandover ? analysis.handover_reason : undefined,
        },
      });

      const previousScore = result.lead.score ?? 0;

      await tx.lead.update({
        where: { id: result.lead.id },
        data: {
          summary: analysis.conversation_summary,
          qualificationStatus: mapQualificationStatus(analysis.qualification_status),
          score: score.totalScore,
          scoreExplanation: score.explanation,
          stageId: stage?.id,
        },
      });

      await tx.leadScore.create({
        data: {
          leadId: result.lead.id,
          totalScore: score.totalScore,
          explanation: score.explanation,
          components: {
            create: score.components.map((c) => ({
              factor: c.factor,
              points: c.points,
              reason: c.reason,
            })),
          },
        },
      });

      if (previousScore !== score.totalScore) {
        await tx.leadScoreEvent.create({
          data: {
            leadId: result.lead.id,
            previousScore,
            newScore: score.totalScore,
            delta: score.totalScore - previousScore,
            reason: score.explanation || "Lead score recalculated from conversation analysis",
            ruleKey: "deterministic_scoring",
            messageId: result.inboundMessage.id,
          },
        });
      }

      for (const objection of analysis.objections_detected) {
        await tx.objection.create({
          data: {
            organisationId: input.organisationId,
            conversationId: result.conversation.id,
            category: objection.category,
            text: objection.text,
          },
        });
      }

      for (const question of analysis.questions_detected) {
        await tx.detectedQuestion.create({
          data: {
            organisationId: input.organisationId,
            conversationId: result.conversation.id,
            text: question,
          },
        });
      }

      for (const signal of analysis.buying_signals) {
        await tx.buyingSignal.create({
          data: {
            organisationId: input.organisationId,
            conversationId: result.conversation.id,
            text: signal,
          },
        });
      }

      const knowledgeGap =
        knowledge.chunks.length === 0 ||
        analysis.confidence < threshold ||
        (analysis.questions_detected.length > 0 && knowledge.documentTitles.length === 0);

      if (knowledgeGap) {
        const gapQuestion =
          analysis.questions_detected[0] ||
          input.message.text.slice(0, 280) ||
          "Unanswered prospect question";
        await tx.knowledgeRecommendation.create({
          data: {
            organisationId: input.organisationId,
            conversationId: result.conversation.id,
            question: gapQuestion,
            draftAnswer: null,
            reason:
              knowledge.chunks.length === 0
                ? "No relevant knowledge chunks retrieved"
                : analysis.confidence < threshold
                  ? "AI confidence below threshold"
                  : "Question detected without supporting documents",
            status: "NEW",
          },
        });
      }
    });

    await recordUsage({
      organisationId: input.organisationId,
      feature: "ai_analysis",
      provider: providerClient.name,
      metadata: { conversationId: result.conversation.id, confidence: analysis.confidence },
    });

    await upsertCampaignAttribution({
      organisationId: input.organisationId,
      contactId: result.contact.id,
      leadId: result.lead.id,
      campaignSource: input.campaignSource,
      leadSource: input.leadSource,
    });

    if (forceHandover) {
      await notifyOnHandover({
        organisationId: input.organisationId,
        conversationId: result.conversation.id,
        reason: analysis.handover_reason,
      });
      await runAutomations({
        organisationId: input.organisationId,
        contactId: result.contact.id,
        conversationId: result.conversation.id,
        leadId: result.lead.id,
        triggerType: "human_requested",
        payload: { reason: analysis.handover_reason },
      });
    }

    if (analysis.sentiment === "negative") {
      await notifyOnNegativeSentiment({
        organisationId: input.organisationId,
        conversationId: result.conversation.id,
      });
      await runAutomations({
        organisationId: input.organisationId,
        contactId: result.contact.id,
        conversationId: result.conversation.id,
        leadId: result.lead.id,
        triggerType: "negative_sentiment",
      });
    }

    await notifyOnHighScore({
      organisationId: input.organisationId,
      leadId: result.lead.id,
      score: score.totalScore,
    });

    await runAutomations({
      organisationId: input.organisationId,
      contactId: result.contact.id,
      conversationId: result.conversation.id,
      leadId: result.lead.id,
      triggerType: "lead_score_changed",
      payload: { score: score.totalScore },
    });

    if (analysis.qualification_status === "qualified") {
      await runAutomations({
        organisationId: input.organisationId,
        contactId: result.contact.id,
        conversationId: result.conversation.id,
        leadId: result.lead.id,
        triggerType: "lead_qualified",
      });
    }

    if (analysis.qualification_status === "disqualified") {
      await runAutomations({
        organisationId: input.organisationId,
        contactId: result.contact.id,
        conversationId: result.conversation.id,
        leadId: result.lead.id,
        triggerType: "lead_disqualified",
      });
    }

    let aiReplySent = false;
    let outboundMessageId: string | undefined;

    if (!forceHandover) {
      const windowState = evaluateMessagingWindow({
        lastInboundAt: result.conversation.lastInboundAt,
        messagingWindowExpiresAt: result.conversation.messagingWindowExpiresAt,
        humanMessagingWindowExpiresAt: result.conversation.humanMessagingWindowExpiresAt,
        aiPaused: false,
        handlingMode: HandlingMode.AI,
        optedOut: result.contact.optedOut,
      });

      if (!windowState.automatedReplyAllowed) {
        await prisma.conversation.update({
          where: { id: result.conversation.id },
          data: { needsHumanReview: true },
        });
        await notifyOrganisationOwners({
          organisationId: input.organisationId,
          type: NotificationType.AI_FAILURE,
          title: "AI reply blocked by messaging window",
          body: windowState.automatedBlockedReason || "Messaging window closed",
          metadata: { conversationId: result.conversation.id },
        });
        await writeAuditLog({
          organisationId: input.organisationId,
          action: "outbound.blocked_messaging_window",
          entityType: "Conversation",
          entityId: result.conversation.id,
          metadata: { reason: windowState.automatedBlockedReason },
        });
      } else {
      let reply = analysis.reply;
      if (analysis.recommended_next_action === "send_booking_link") {
        const booking = await getBookingProvider().createBookingLink({
          organisationId: input.organisationId,
          contactId: result.contact.id,
          conversationId: result.conversation.id,
          leadId: result.lead.id,
          bookingUrl: agentConfig?.bookingUrl || process.env.DEFAULT_BOOKING_URL,
        });
        if (booking.url && !reply.includes(booking.url)) {
          reply = `${reply}\n\nBook here: ${booking.url}`;
        }
        await prisma.booking.create({
          data: {
            organisationId: input.organisationId,
            contactId: result.contact.id,
            conversationId: result.conversation.id,
            leadId: result.lead.id,
            provider: process.env.BOOKING_PROVIDER || "link",
            status: BookingStatus.OFFERED,
            bookingUrl: booking.url || agentConfig?.bookingUrl || process.env.DEFAULT_BOOKING_URL,
            attribution: {
              source: input.leadSource || "instagram_manychat",
              campaign: input.campaignSource || null,
            },
          },
        });
        await runAutomations({
          organisationId: input.organisationId,
          contactId: result.contact.id,
          conversationId: result.conversation.id,
          leadId: result.lead.id,
          triggerType: "booking_link_sent",
          payload: { bookingUrl: booking.url },
        });
      }

      const adapter = getMessagingAdapter();
      const sendResult = await adapter.sendMessage({
        organisationId: input.organisationId,
        contactExternalId: input.contact.externalId,
        text: reply,
        threadId: result.conversation.externalThreadId ?? undefined,
      });

      if (sendResult.ok) {
        const outboundAt = new Date();
        const outbound = await prisma.message.create({
          data: {
            conversationId: result.conversation.id,
            organisationId: input.organisationId,
            externalId: sendResult.externalMessageId,
            direction: MessageDirection.OUTBOUND,
            senderType: MessageSenderType.AI,
            body: reply,
            aiMetadata: {
              provider: providerClient.name,
              model: agentConfig?.model,
              confidence: analysis.confidence,
              repaired: analysisResult.repaired,
              recommended_next_action: analysis.recommended_next_action,
              knowledgeDocuments: knowledge.documentTitles,
              latencyMs: analysisLatencyMs,
            },
            deliveryStatus: "sent",
          },
        });
        outboundMessageId = outbound.id;
        aiReplySent = true;

        await prisma.conversation.update({
          where: { id: result.conversation.id },
          data: {
            lastMessageAt: outboundAt,
            lastMessagePreview: reply.slice(0, 140),
            lastOutboundAt: outboundAt,
          },
        });

        await recordUsage({
          organisationId: input.organisationId,
          feature: "ai_reply",
          provider: providerClient.name,
          metadata: { conversationId: result.conversation.id, messageId: outbound.id },
        });
      } else {
        logger.error("Failed to send AI reply", { error: sendResult.error });
        await prisma.conversation.update({
          where: { id: result.conversation.id },
          data: { needsHumanReview: true },
        });
        await notifyOrganisationOwners({
          organisationId: input.organisationId,
          type: NotificationType.AI_FAILURE,
          title: "Message delivery failed",
          body: sendResult.error || "Outbound send failed",
          metadata: { conversationId: result.conversation.id },
        });
      }

      const delays = Array.isArray(agentConfig?.followUpDelaysMinutes)
        ? (agentConfig?.followUpDelaysMinutes as number[])
        : [60, 1440, 4320];

      await scheduleFollowUps({
        organisationId: input.organisationId,
        contactId: result.contact.id,
        conversationId: result.conversation.id,
        leadId: result.lead.id,
        delaysMinutes: delays,
        maxFollowUps: agentConfig?.maxFollowUps ?? 3,
      });
      }
    } else {
      await writeAuditLog({
        organisationId: input.organisationId,
        action: "conversation.handover",
        entityType: "Conversation",
        entityId: result.conversation.id,
        metadata: {
          reason: analysis.handover_reason,
          confidence: analysis.confidence,
        },
      });
    }

    await writeAuditLog({
      organisationId: input.organisationId,
      action: "inbound.processed",
      entityType: "Conversation",
      entityId: result.conversation.id,
      metadata: {
        leadId: result.lead.id,
        score: score.totalScore,
        aiReplySent,
        provider: providerClient.name,
        latencyMs: analysisLatencyMs,
      },
    });

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
    });

    return {
      duplicate: false,
      webhookEventId: webhookEvent.id,
      contactId: result.contact.id,
      conversationId: result.conversation.id,
      messageId: result.inboundMessage.id,
      leadId: result.lead.id,
      aiReplySent,
      needsHumanReview: forceHandover,
      outboundMessageId,
      analysis: analysis as unknown as Record<string, unknown>,
    };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Inbound processing failed")
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?")
      .slice(0, 1000);
    logger.error("Inbound processing error", { message });
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: WebhookProcessingStatus.FAILED,
        error: message,
      },
    });
    throw error;
  }
}
