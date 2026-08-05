import {
  HandlingMode,
  MessageDirection,
  MessageSenderType,
  QualificationStatus,
  WebhookProcessingStatus,
} from "@prisma/client";
import { analyseWithValidation, buildAgentSystemPrompt, getAiProvider } from "@/adapters/ai";
import { getMessagingAdapter } from "@/adapters/messaging";
import { hashForIdempotency } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { InboundMessageInput } from "@/schemas/webhook";
import { writeAuditLog } from "@/services/audit";
import { cancelFollowUpsOnOptOut, cancelPendingFollowUps, scheduleFollowUps } from "@/services/followups";
import { retrieveRelevantKnowledge } from "@/services/knowledge";
import { calculateLeadScore } from "@/services/scoring";

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
  return pipeline.stages.find((s) => s.slug === slug) ?? pipeline.stages.sort((a, b) => a.position - b.position)[0] ?? null;
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

  if (existing && existing.status === WebhookProcessingStatus.PROCESSED) {
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

      const identifier = `manychat:${input.contact.externalId}`;
      const contactIdentifier = await tx.contactIdentifier.findUnique({
        where: { channel_identifier: { channel: "manychat", identifier } },
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
                channel: "manychat",
                identifier,
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
              contactId: contact.id,
              channel: "manychat",
              identifier,
            },
          });
        }
      }

      const threadKey = input.threadId || `manychat:${input.contact.externalId}`;
      let conversation = await tx.conversation.findFirst({
        where: {
          organisationId: input.organisationId,
          OR: [
            { externalThreadId: threadKey },
            { contactId: contact.id, deletedAt: null },
          ],
        },
        orderBy: { updatedAt: "desc" },
      });

      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            organisationId: input.organisationId,
            contactId: contact.id,
            messagingChannelId: channel.id,
            externalThreadId: threadKey,
            handlingMode: HandlingMode.AI,
            unreadCount: 1,
            lastMessageAt: new Date(),
            lastMessagePreview: input.message.text.slice(0, 140),
          },
        });
      } else {
        conversation = await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            unreadCount: { increment: 1 },
            lastMessageAt: new Date(),
            lastMessagePreview: input.message.text.slice(0, 140),
            externalThreadId: conversation.externalThreadId || threadKey,
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

    if (result.contact.optedOut) {
      await cancelFollowUpsOnOptOut(result.contact.id);
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookProcessingStatus.PROCESSED,
          processedAt: new Date(),
        },
      });
      await writeAuditLog({
        organisationId: input.organisationId,
        action: "inbound.skipped_opt_out",
        entityType: "Contact",
        entityId: result.contact.id,
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

    // Cancel follow-ups because the lead replied
    await cancelPendingFollowUps({
      conversationId: result.conversation.id,
      reason: "Lead replied",
    });

    const aiEnabled =
      !result.conversation.aiPaused &&
      result.conversation.handlingMode === HandlingMode.AI;

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

    const agentConfig = await prisma.agentConfiguration.findFirst({
      where: { organisationId: input.organisationId, isActive: true },
      orderBy: { updatedAt: "desc" },
    });

    const knowledge = await retrieveRelevantKnowledge({
      organisationId: input.organisationId,
      query: input.message.text,
    });

    const recentMessages = await prisma.message.findMany({
      where: { conversationId: result.conversation.id },
      orderBy: { sentAt: "asc" },
      take: 30,
    });

    const transcript = recentMessages
      .map((m) => `${m.senderType}: ${m.body}`)
      .join("\n");

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

    const analysisResult = await analyseWithValidation(providerClient, {
      model: agentConfig?.model,
      systemPrompt,
      conversationTranscript: transcript,
      knowledgeContext: knowledge.chunks.join("\n\n"),
      leadMessage: input.message.text,
    });

    if (!analysisResult.ok) {
      await prisma.conversation.update({
        where: { id: result.conversation.id },
        data: {
          needsHumanReview: true,
          handlingMode: HandlingMode.HUMAN,
          aiPaused: true,
        },
      });
      await writeAuditLog({
        organisationId: input.organisationId,
        action: "ai.validation_failed",
        entityType: "Conversation",
        entityId: result.conversation.id,
        metadata: { reason: analysisResult.reason },
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
    const forceHandover =
      analysis.should_handover || analysis.confidence < threshold;

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
        },
      });

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

      const leadScore = await tx.leadScore.create({
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

      void leadScore;

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
    });

    let aiReplySent = false;
    let outboundMessageId: string | undefined;

    if (!forceHandover) {
      let reply = analysis.reply;
      if (
        analysis.recommended_next_action === "send_booking_link" &&
        (agentConfig?.bookingUrl || process.env.DEFAULT_BOOKING_URL)
      ) {
        const url = agentConfig?.bookingUrl || process.env.DEFAULT_BOOKING_URL;
        if (url && !reply.includes(url)) {
          reply = `${reply}\n\nBook here: ${url}`;
        }
      }

      const adapter = getMessagingAdapter(false);
      const sendResult = await adapter.sendMessage({
        organisationId: input.organisationId,
        contactExternalId: input.contact.externalId,
        text: reply,
        threadId: result.conversation.externalThreadId ?? undefined,
      });

      if (sendResult.ok) {
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
              confidence: analysis.confidence,
              repaired: analysisResult.repaired,
              recommended_next_action: analysis.recommended_next_action,
              knowledgeDocuments: knowledge.documentTitles,
            },
            deliveryStatus: "sent",
          },
        });
        outboundMessageId = outbound.id;
        aiReplySent = true;

        await prisma.conversation.update({
          where: { id: result.conversation.id },
          data: {
            lastMessageAt: new Date(),
            lastMessagePreview: reply.slice(0, 140),
          },
        });
      } else {
        logger.error("Failed to send AI reply", { error: sendResult.error });
        await prisma.conversation.update({
          where: { id: result.conversation.id },
          data: { needsHumanReview: true },
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
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Inbound processing failed";
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
