/**
 * LinkedIn native communications adapter — V2 READY, HARD-DISABLED by default.
 *
 * Never use browser automation against linkedin.com.
 * Never simulate success when APIs are not approved.
 */

import {
  SocialCapabilityBlockedError,
  resolveLinkedInCommunicationsAvailability,
  type SocialCapability,
} from "@/services/social-prospecting/capabilities";

function reject(capability: SocialCapability): never {
  const code = resolveLinkedInCommunicationsAvailability(
    capability as
      | "CONNECTION_INVITE"
      | "CONNECTION_STATUS"
      | "CONVERSATION_READ"
      | "CONVERSATION_WRITE"
      | "DIRECT_MESSAGES",
  );
  if (code === "AVAILABLE") {
    // Approval flags flipped — still not implemented against live LinkedIn APIs in this pass.
    throw new SocialCapabilityBlockedError({
      provider: "LINKEDIN_NATIVE",
      capability,
      code: "REQUIRES_PROVIDER_APPROVAL",
      message:
        "LinkedIn restricted API flags are set but the live adapter is not production-wired yet",
    });
  }
  throw new SocialCapabilityBlockedError({
    provider: "LINKEDIN_NATIVE",
    capability,
    code: "REQUIRES_PROVIDER_APPROVAL",
    message:
      "LinkedIn connection/messaging APIs require official LinkedIn approval. Use Version 1 Open/Copy workflow.",
  });
}

export async function sendConnectionInvitation(_args: {
  organisationId: string;
  profileUrl: string;
  note?: string;
}): Promise<never> {
  void _args;
  return reject("CONNECTION_INVITE");
}

export async function getInvitationStatus(_args: {
  organisationId: string;
  invitationId: string;
}): Promise<never> {
  void _args;
  return reject("CONNECTION_STATUS");
}

export async function listAuthenticatedUserConnections(_args: {
  organisationId: string;
}): Promise<never> {
  void _args;
  return reject("CONNECTION_STATUS");
}

export async function sendLinkedInMessage(_args: {
  organisationId: string;
  recipientUrn: string;
  body: string;
}): Promise<never> {
  void _args;
  return reject("DIRECT_MESSAGES");
}

export async function replyToLinkedInConversation(_args: {
  organisationId: string;
  conversationId: string;
  body: string;
}): Promise<never> {
  void _args;
  return reject("CONVERSATION_WRITE");
}

export async function getLinkedInConversation(_args: {
  organisationId: string;
  conversationId: string;
}): Promise<never> {
  void _args;
  return reject("CONVERSATION_READ");
}

/** Safe introspection for UI — never claims Send is available without approval. */
export function linkedInV1ActionSurface() {
  return {
    version: "V1" as const,
    sendConnection: false,
    sendMessage: false,
    actions: ["OPEN_LINKEDIN", "COPY_CONNECTION_NOTE", "COPY_FOLLOW_UP", "MARK_STATE"] as const,
    actionMode: "HUMAN_ACTION_REQUIRED" as const,
    note: "Manual Open/Copy workflow — system does not claim LinkedIn sends occurred",
  };
}

export function linkedInV2ActionSurface() {
  const invite = resolveLinkedInCommunicationsAvailability("CONNECTION_INVITE");
  const messages = resolveLinkedInCommunicationsAvailability("DIRECT_MESSAGES");
  return {
    version: "V2" as const,
    sendConnection: invite === "AVAILABLE",
    sendMessage: messages === "AVAILABLE",
    inviteAvailability: invite,
    messageAvailability: messages,
  };
}
