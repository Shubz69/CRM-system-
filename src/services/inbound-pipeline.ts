import {
  BookingStatus,
  HandlingMode,
  MessageDirection,
  MessageSenderType,
  Prisma,
  QualificationStatus,
  WebhookProcessingStatus,
} from "@prisma/client";
import { buildAgentSystemPrompt } from "@/adapters/ai";
import { getBookingProvider } from "@/adapters/booking";
import { hashForIdempotency } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { evaluateMessagingWindow, openMessagingWindows } from "@/lib/messaging-window";
import type { InboundMessageInput } from "@/schemas/webhook";
import { writeAuditLog } from "@/services/audit";
import { upsertCampaignAttribution } from "@/services/attribution";
import { runAutomations } from "@/services/automations";
import { routeAndAnalyse } from "@/services/ai-router";
import { flattenCrmMemory, mergeCrmMemory, readCrmMemory } from "@/services/crm-memory";
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
import {
  capabilityAllowsAuto,
  capabilityRequiresApproval,
  isAutopilotOperating,
  parseAutopilotConfig,
} from "@/services/autopilot";
import { isIntelligenceFlagEnabled } from "@/services/intelligence-flags";
import { decideNextBestAction } from "@/services/messaging/nba";
import { recordObjection } from "@/services/messaging/objections";
import { prepareAndSendOutbound } from "@/services/messaging/outbound";
import {
  classifyInboundL0,
  persistUnderstanding,
  runUnderstandingShadow,
} from "@/services/messaging/understanding";
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

  const organisation = await prisma.organisation.findFirst({
    where: { id: input.organisationId, deletedAt: null },
    select: {
      id: true,
      status: true,
      autopilotMode: true,
      autopilotConfig: true,
    },
  });

  if (!organisation) {
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: WebhookProcessingStatus.FAILED,
        error: "Organisation not found",
        processedAt: new Date(),
      },
    });
    throw new Error("Organisation not found");
  }

  if (organisation.status === "SUSPENDED") {
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: WebhookProcessingStatus.IGNORED,
        error: "Workspace suspended",
        processedAt: new Date(),
      },
    });
    return { duplicate: false, webhookEventId: webhookEvent.id };
  }

  const autopilotConfig = parseAutopilotConfig(organisation.autopilotConfig);
  const autopilotActive = isAutopilotOperating(organisation.autopilotMode, { provider });

  try {
    await prisma.organisation.update({
      where: { id: organisation.id },
      data: { lastActivityAt: new Date() },
    });

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

      let contactCreated = false;
      let contactUpdated = false;
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
            metadata:
              provider === "simulator"
                ? { origin: "simulator" }
                : provider === "integration_test"
                  ? { origin: "integration_test" }
                  : {},
            identifiers: {
              create: {
                organisationId: input.organisationId,
                channel: "manychat",
                identifier: identifierValue,
              },
            },
          },
        });
        contactCreated = true;
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
        contactUpdated = true;

        if (!contactIdentifier) {
          try {
            await tx.contactIdentifier.create({
              data: {
                organisationId: input.organisationId,
                contactId: contact.id,
                channel: "manychat",
                identifier: identifierValue,
              },
            });
          } catch (error) {
            if (
              !(error instanceof Prisma.PrismaClientKnownRequestError) ||
              error.code !== "P2002"
            ) {
              throw error;
            }
            const raced = await tx.contactIdentifier.findUnique({
              where: {
                organisationId_channel_identifier: {
                  organisationId: input.organisationId,
                  channel: "manychat",
                  identifier: identifierValue,
                },
              },
              include: { contact: true },
            });
            if (raced?.contact) {
              contact = raced.contact;
            }
          }
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

      let conversationCreated = false;
      if (!conversation) {
        const windows = openMessagingWindows();
        try {
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
          conversationCreated = true;
        } catch (error) {
          if (
            !(error instanceof Prisma.PrismaClientKnownRequestError) ||
            error.code !== "P2002"
          ) {
            throw error;
          }
          conversation = await tx.conversation.findUnique({
            where: {
              organisationId_externalThreadId: {
                organisationId: input.organisationId,
                externalThreadId: threadKey,
              },
            },
          });
          if (!conversation) throw error;
        }
      }
      if (!conversationCreated && conversation) {
        const windows = openMessagingWindows();
        conversation = await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            unreadCount: { increment: 1 },
            activityVersion: { increment: 1 },
            lastMessageAt: windows.lastInboundAt,
            lastMessagePreview: input.message.text.slice(0, 140),
            externalThreadId: conversation.externalThreadId || threadKey,
            lastInboundAt: windows.lastInboundAt,
            messagingWindowExpiresAt: windows.messagingWindowExpiresAt,
            humanMessagingWindowExpiresAt: windows.humanMessagingWindowExpiresAt,
          },
        });
      }

      if (!conversation) {
        throw new Error("Conversation could not be created or resolved");
      }

      const externalId =
        input.message.externalId || `in_${idempotencyKey.slice(0, 24)}`;
      let inboundMessage;
      if (input.message.externalId) {
        inboundMessage = await tx.message.upsert({
          where: {
            conversationId_externalId: {
              conversationId: conversation.id,
              externalId,
            },
          },
          create: {
            conversationId: conversation.id,
            organisationId: input.organisationId,
            externalId,
            direction: MessageDirection.INBOUND,
            senderType: MessageSenderType.CONTACT,
            body: input.message.text,
            origin: provider,
            rawPayload: (options?.rawPayload as object) ?? undefined,
            sentAt: input.message.sentAt ? new Date(input.message.sentAt) : new Date(),
          },
          update: {},
        });
      } else {
        try {
          inboundMessage = await tx.message.create({
            data: {
              conversationId: conversation.id,
              organisationId: input.organisationId,
              externalId,
              direction: MessageDirection.INBOUND,
              senderType: MessageSenderType.CONTACT,
              body: input.message.text,
              origin: provider,
              rawPayload: (options?.rawPayload as object) ?? undefined,
              sentAt: input.message.sentAt ? new Date(input.message.sentAt) : new Date(),
            },
          });
        } catch (error) {
          if (
            !(error instanceof Prisma.PrismaClientKnownRequestError) ||
            error.code !== "P2002"
          ) {
            throw error;
          }
          const existingMessage = await tx.message.findUnique({
            where: {
              conversationId_externalId: {
                conversationId: conversation.id,
                externalId,
              },
            },
          });
          if (!existingMessage) throw error;
          inboundMessage = existingMessage;
        }
      }

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

      let leadCreated = false;
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
        leadCreated = true;
      }

      const { appendDomainEvent } = await import("@/services/domain-events/append");
      if (contactCreated) {
        await appendDomainEvent(tx, {
          organisationId: input.organisationId,
          eventType: "CONTACT_CREATED",
          aggregateType: "Contact",
          aggregateId: contact.id,
          payload: { contactId: contact.id },
          dedupeKey: `CONTACT_CREATED:${contact.id}`,
        });
      } else if (contactUpdated) {
        await appendDomainEvent(tx, {
          organisationId: input.organisationId,
          eventType: "CONTACT_UPDATED",
          aggregateType: "Contact",
          aggregateId: contact.id,
          payload: { contactId: contact.id },
          dedupeKey: `CONTACT_UPDATED:${contact.id}:${inboundMessage.id}`,
        });
      }
      if (conversationCreated) {
        await appendDomainEvent(tx, {
          organisationId: input.organisationId,
          eventType: "CONVERSATION_CREATED",
          aggregateType: "Conversation",
          aggregateId: conversation.id,
          payload: { conversationId: conversation.id, contactId: contact.id },
          dedupeKey: `CONVERSATION_CREATED:${conversation.id}`,
        });
      }
      await appendDomainEvent(tx, {
        organisationId: input.organisationId,
        eventType: "MESSAGE_RECEIVED",
        aggregateType: "Message",
        aggregateId: inboundMessage.id,
        payload: {
          messageId: inboundMessage.id,
          conversationId: conversation.id,
          contactId: contact.id,
        },
        dedupeKey: `MESSAGE_RECEIVED:${inboundMessage.id}`,
      });
      if (leadCreated) {
        await appendDomainEvent(tx, {
          organisationId: input.organisationId,
          eventType: "LEAD_CREATED",
          aggregateType: "Lead",
          aggregateId: lead.id,
          payload: { leadId: lead.id, contactId: contact.id },
          dedupeKey: `LEAD_CREATED:${lead.id}`,
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

    const l0 = classifyInboundL0(input.message.text);

    if (await isIntelligenceFlagEnabled(input.organisationId, "messagingUnderstandingShadow")) {
      await runUnderstandingShadow({
        organisationId: input.organisationId,
        text: input.message.text,
      }).catch((error) => {
        logger.warn("Understanding shadow failed", {
          message: error instanceof Error ? error.message : "unknown",
        });
      });
    }

    if (await isIntelligenceFlagEnabled(input.organisationId, "messagingNbaShadow")) {
      // Shadow only — never drive outbound sends from NBA.
      void decideNextBestAction({
        optedOut: l0.optedOut || result.contact.optedOut,
        meetingIntent: l0.meetingIntent,
        priceObjection: l0.objectionCategory === "PRICE",
        objectionCategory: l0.objectionCategory,
        qualificationStatus: result.lead.qualificationStatus,
        qualified: result.lead.qualificationStatus === QualificationStatus.QUALIFIED,
      });
    }

    if (l0.objectionCategory === "PRICE") {
      await recordObjection({
        organisationId: input.organisationId,
        conversationId: result.conversation.id,
        category: "PRICE",
        evidenceMessageId: result.inboundMessage.id,
        text: input.message.text.slice(0, 280),
      }).catch((error) => {
        logger.warn("Failed to record price objection", {
          message: error instanceof Error ? error.message : "unknown",
        });
      });
    }

    if (l0.meetingIntent) {
      await persistUnderstanding({
        organisationId: input.organisationId,
        conversationId: result.conversation.id,
        understanding: l0,
        evidenceMessageIds: [result.inboundMessage.id],
      }).catch((error) => {
        logger.warn("Failed to persist meeting understanding", {
          message: error instanceof Error ? error.message : "unknown",
        });
      });
    }

    if (detectOptOut(input.message.text, optOutKeywords) || l0.optedOut || result.contact.optedOut) {
      if (!result.contact.optedOut) {
        await applyOptOut({
          organisationId: input.organisationId,
          contactId: result.contact.id,
          source: "inbound_keyword",
          reason: input.message.text.slice(0, 200),
          conversationId: result.conversation.id,
        });
      } else {
        await cancelFollowUpsOnOptOut({
          organisationId: input.organisationId,
          contactId: result.contact.id,
        });
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
      organisationId: input.organisationId,
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
      autopilotActive &&
      capabilityAllowsAuto(autopilotConfig, "aiResponses") &&
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

    const knowledge = await retrieveRelevantKnowledge({
      organisationId: input.organisationId,
      query: input.message.text,
    });

    const recentMessages = await prisma.message.findMany({
      where: { conversationId: result.conversation.id },
      orderBy: { sentAt: "asc" },
      take: 20,
    });

    const transcript = recentMessages.map((m) => `${m.senderType}: ${m.body}`).join("\n");
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

    const existingMemory = readCrmMemory(result.lead.metadata);
    const routed = await routeAndAnalyse({
      organisationId: input.organisationId,
      taskType: "conversation",
      agentProvider: agentConfig?.aiProvider || "anthropic",
      modelOverride: agentConfig?.model?.startsWith("claude") ? agentConfig.model : null,
      leadScore: result.lead.score ?? 0,
      systemPrompt,
      conversationTranscript: transcript,
      knowledgeContext: knowledge.chunks.join("\n\n"),
      leadMessage: input.message.text,
      crmMemory: flattenCrmMemory(existingMemory),
    });
    const analysisResult = routed.result;
    const analysisLatencyMs = routed.latencyMs;

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

    if (capabilityAllowsAuto(autopilotConfig, "qualification")) {
      await syncQualificationAnswers({
        organisationId: input.organisationId,
        leadId: result.lead.id,
        answers: analysis.answers_collected,
      });
    }

    const score = calculateLeadScore({
      analysis,
      rules: (agentConfig?.scoringRules as { weights?: Record<string, number> }) ?? undefined,
      messageCount: recentMessages.length,
    });

    const allowPipeline = capabilityAllowsAuto(autopilotConfig, "pipelineManagement");
    const allowScoring = capabilityAllowsAuto(autopilotConfig, "leadScoring");
    const allowBooking = capabilityAllowsAuto(autopilotConfig, "booking");
    const bookingNeedsApproval =
      analysis.recommended_next_action === "send_booking_link" &&
      !allowBooking &&
      capabilityRequiresApproval(autopilotConfig, "booking");

    let stageSlug = "engaged";
    if (analysis.qualification_status === "qualified") stageSlug = "qualified";
    if (analysis.qualification_status === "disqualified") stageSlug = "disqualified";
    if (analysis.recommended_next_action === "send_booking_link" && allowBooking) {
      stageSlug = "booking_offered";
    }
    if (forceHandover) stageSlug = "qualifying";

    const stage = allowPipeline
      ? await getDefaultStage(input.organisationId, stageSlug)
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: result.conversation.id },
        data: {
          summary: analysis.conversation_summary,
          intent: analysis.intent,
          sentiment: analysis.sentiment,
          needsHumanReview: forceHandover || bookingNeedsApproval,
          handlingMode: forceHandover ? HandlingMode.HUMAN : HandlingMode.AI,
          aiPaused: forceHandover,
          handoffReason: forceHandover ? analysis.handover_reason : undefined,
        },
      });

      const previousScore = result.lead.score ?? 0;
      const existingMeta =
        result.lead.metadata && typeof result.lead.metadata === "object"
          ? (result.lead.metadata as Record<string, unknown>)
          : {};
      const crmMemory = mergeCrmMemory({
        existing: existingMemory,
        updates: {
          ...(analysis.crm_updates || {}),
          need: analysis.crm_updates?.need || analysis.intent || undefined,
          objections: analysis.objections_detected.map((o) => o.text),
          questions: analysis.questions_detected,
          previousAnswers: Object.entries(analysis.answers_collected).map(
            ([k, v]) => `${k}: ${v}`,
          ),
          bookingStatus: analysis.recommended_next_action,
          lastAction: analysis.recommended_next_action,
          nextAction: analysis.recommended_next_action,
          conversationSummary: analysis.conversation_summary,
        },
        confidence: analysis.confidence,
        messageId: result.inboundMessage.id,
        source: "AI",
      });

      await tx.lead.update({
        where: { id: result.lead.id },
        data: {
          summary: analysis.conversation_summary,
          qualificationStatus: capabilityAllowsAuto(autopilotConfig, "qualification")
            ? mapQualificationStatus(analysis.qualification_status)
            : undefined,
          score: allowScoring ? score.totalScore : undefined,
          scoreExplanation: allowScoring ? score.explanation : undefined,
          stageId: stage?.id ?? undefined,
          metadata: {
            ...existingMeta,
            crmMemory,
            aiProvider: routed.provider,
            aiModel: routed.model,
            aiTaskType: routed.taskType,
            stageChangedBy: allowPipeline
              ? "AI"
              : typeof existingMeta.stageChangedBy === "string"
                ? existingMeta.stageChangedBy
                : null,
          } as Prisma.InputJsonValue,
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

      if (analysis.knowledge_gap?.detected) {
        await tx.knowledgeRecommendation.create({
          data: {
            organisationId: input.organisationId,
            conversationId: result.conversation.id,
            question: (analysis.knowledge_gap.question || input.message.text).slice(0, 280),
            reason: analysis.knowledge_gap.reason || "Claude detected a knowledge gap",
            status: "NEW",
          },
        });
        await writeAuditLog({
          organisationId: input.organisationId,
          action: "knowledge.gap",
          entityType: "Conversation",
          entityId: result.conversation.id,
          metadata: {
            question: analysis.knowledge_gap.question,
            reason: analysis.knowledge_gap.reason,
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
      provider: routed.provider,
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
      if (analysis.recommended_next_action === "send_booking_link" && allowBooking) {
        const booking = await getBookingProvider().createBookingLink({
          organisationId: input.organisationId,
          contactId: result.contact.id,
          conversationId: result.conversation.id,
          leadId: result.lead.id,
          bookingUrl: agentConfig?.bookingUrl || process.env.DEFAULT_BOOKING_URL,
        });
        if (booking.url) {
          if (!reply.includes(booking.url)) {
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
              bookingUrl: booking.url,
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
      }

      const sendResult = await prepareAndSendOutbound({
        organisationId: input.organisationId,
        conversationId: result.conversation.id,
        contactId: result.contact.id,
        contactExternalId: input.contact.externalId,
        text: reply,
        source: "AI",
        holder: `ai:${result.conversation.id}`,
        idempotencyKey: `ai-reply:${result.inboundMessage.id}`,
        threadId: result.conversation.externalThreadId ?? undefined,
        agentVersion: routed.model,
      });

      if (sendResult.ok && sendResult.dispatch?.messageId) {
        outboundMessageId = sendResult.dispatch.messageId;
        aiReplySent = true;

        await prisma.message.update({
          where: { id: sendResult.dispatch.messageId },
          data: {
            aiMetadata: {
              provider: routed.provider,
              model: routed.model,
              taskType: routed.taskType,
              tier: routed.tier,
              confidence: analysis.confidence,
              repaired: analysisResult.repaired,
              recommended_next_action: analysis.recommended_next_action,
              knowledgeDocuments: knowledge.documentTitles,
              latencyMs: analysisLatencyMs,
            },
          },
        }).catch(() => undefined);

        await recordUsage({
          organisationId: input.organisationId,
          feature: "ai_reply",
          provider: routed.provider,
          metadata: {
            conversationId: result.conversation.id,
            messageId: sendResult.dispatch.messageId,
          },
        });
      } else if (!sendResult.ok) {
        logger.error("Failed to send AI reply", {
          code: "code" in sendResult ? sendResult.code : "UNKNOWN",
        });
        if (sendResult.code !== "STALE_CONTEXT") {
          await prisma.conversation.update({
            where: { id: result.conversation.id },
            data: { needsHumanReview: true },
          });
          await notifyOrganisationOwners({
            organisationId: input.organisationId,
            type: NotificationType.AI_FAILURE,
            title: "Message delivery failed",
            body:
              typeof sendResult.code === "string"
                ? sendResult.code
                : "Outbound send failed",
            metadata: { conversationId: result.conversation.id },
          });
        }
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
        skipIfAutopilotDisabled: true,
        policyInputs: {
          intent: analysis.intent || l0.intent,
          qualificationStatus: analysis.qualification_status || result.lead.qualificationStatus,
          attemptNumber: 0,
          maxAttempts: agentConfig?.maxFollowUps ?? 3,
          meetingBooked: analysis.recommended_next_action === "send_booking_link",
          optedOut: false,
          lastInboundAt: result.conversation.lastInboundAt,
        },
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
        provider: routed.provider,
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
