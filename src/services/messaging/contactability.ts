import { MessageDirection } from "@prisma/client";
import { prisma } from "@/lib/db";
import { evaluateMessagingWindow } from "@/lib/messaging-window";
import { isMetaInstagramProvider } from "@/services/messaging/providers";
import { isContactSuppressed } from "@/services/messaging/suppression";

export type ContactabilityActionType =
  | "AI_REPLY"
  | "AUTOMATED_REPLY"
  | "FOLLOW_UP"
  | "CAMPAIGN"
  | "HUMAN_REPLY"
  | "HUMAN";

export type ContactabilityCode =
  | "CONTACT_NOT_FOUND"
  | "CONTACT_OPTED_OUT"
  | "CONTACT_SUPPRESSED"
  | "DO_NOT_CONTACT"
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_CLOSED"
  | "AI_PAUSED"
  | "MESSAGING_WINDOW_CLOSED"
  | "PROVIDER_POLICY_BLOCKED"
  | "META_INSTAGRAM_NO_PRIOR_INBOUND";

export class ContactabilityError extends Error {
  constructor(
    readonly code: ContactabilityCode,
    message: string,
  ) {
    super(message);
    this.name = "ContactabilityError";
  }
}

function metadataBlocksContact(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return (
    record.DO_NOT_CONTACT === true ||
    record.doNotContact === true ||
    record.do_not_contact === true ||
    record.contactability === "DO_NOT_CONTACT"
  );
}

export async function assertContactable(input: {
  organisationId: string;
  contactId: string;
  conversationId?: string;
  channel?: string;
  actionType: ContactabilityActionType | string;
}): Promise<void> {
  const contact = await prisma.contact.findFirst({
    where: {
      id: input.contactId,
      organisationId: input.organisationId,
      deletedAt: null,
    },
    select: { optedOut: true, metadata: true },
  });
  if (!contact) {
    throw new ContactabilityError("CONTACT_NOT_FOUND", "Contact was not found");
  }
  if (contact.optedOut) {
    throw new ContactabilityError("CONTACT_OPTED_OUT", "Contact has opted out");
  }
  if (metadataBlocksContact(contact.metadata)) {
    throw new ContactabilityError("DO_NOT_CONTACT", "Contact is marked do not contact");
  }
  if (
    await isContactSuppressed(
      input.organisationId,
      input.contactId,
      input.channel,
    )
  ) {
    throw new ContactabilityError("CONTACT_SUPPRESSED", "Contact is actively suppressed");
  }

  if (!input.conversationId) return;
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: input.conversationId,
      organisationId: input.organisationId,
      contactId: input.contactId,
      deletedAt: null,
    },
    select: {
      closedAt: true,
      aiPaused: true,
      handlingMode: true,
      lastInboundAt: true,
      messagingWindowExpiresAt: true,
      humanMessagingWindowExpiresAt: true,
      metadata: true,
    },
  });
  if (!conversation) {
    throw new ContactabilityError("CONVERSATION_NOT_FOUND", "Conversation was not found");
  }
  if (conversation.closedAt) {
    throw new ContactabilityError("CONVERSATION_CLOSED", "Conversation is closed");
  }
  if (metadataBlocksContact(conversation.metadata)) {
    throw new ContactabilityError(
      "DO_NOT_CONTACT",
      "Conversation is marked do not contact",
    );
  }

  // Meta Instagram: no cold DMs — require prior customer inbound on this conversation.
  if (isMetaInstagramProvider(input.channel)) {
    const priorInbound = await prisma.message.findFirst({
      where: {
        organisationId: input.organisationId,
        conversationId: input.conversationId,
        direction: MessageDirection.INBOUND,
      },
      select: { id: true },
    });
    if (!priorInbound) {
      throw new ContactabilityError(
        "META_INSTAGRAM_NO_PRIOR_INBOUND",
        "Meta Instagram forbids outbound without a prior customer message on this conversation",
      );
    }
  }

  const isHuman = input.actionType === "HUMAN" || input.actionType === "HUMAN_REPLY";
  if (isHuman) return;
  if (conversation.aiPaused || conversation.handlingMode === "HUMAN") {
    throw new ContactabilityError("AI_PAUSED", "Automated messaging is paused");
  }
  const window = evaluateMessagingWindow(conversation);
  if (!window.automatedReplyAllowed) {
    throw new ContactabilityError(
      "MESSAGING_WINDOW_CLOSED",
      window.automatedBlockedReason ?? "Automated messaging window is closed",
    );
  }
}
