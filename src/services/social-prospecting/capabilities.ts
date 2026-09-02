/**
 * Canonical social provider capability matrix.
 * Never infer capability merely because a provider is configured.
 */

export const SOCIAL_PROVIDER = {
  AYRSHARE: "AYRSHARE",
  META_INSTAGRAM: "META_INSTAGRAM",
  MANYCHAT: "MANYCHAT",
  LINKEDIN_NATIVE: "LINKEDIN_NATIVE",
} as const;

export type SocialProviderId = (typeof SOCIAL_PROVIDER)[keyof typeof SOCIAL_PROVIDER];

export const SOCIAL_CAPABILITY = {
  CONNECT_ACCOUNT: "CONNECT_ACCOUNT",
  PUBLISH: "PUBLISH",
  SCHEDULE: "SCHEDULE",
  ANALYTICS: "ANALYTICS",
  HISTORY: "HISTORY",
  COMMENTS: "COMMENTS",
  DIRECT_MESSAGES: "DIRECT_MESSAGES",
  PROFILE_LOOKUP: "PROFILE_LOOKUP",
  DISCOVERY: "DISCOVERY",
  CONNECTION_INVITE: "CONNECTION_INVITE",
  CONNECTION_STATUS: "CONNECTION_STATUS",
  CONVERSATION_READ: "CONVERSATION_READ",
  CONVERSATION_WRITE: "CONVERSATION_WRITE",
} as const;

export type SocialCapability = (typeof SOCIAL_CAPABILITY)[keyof typeof SOCIAL_CAPABILITY];

export type CapabilityAvailability =
  | "AVAILABLE"
  | "NOT_CONFIGURED"
  | "REQUIRES_PROVIDER_APPROVAL"
  | "HUMAN_ACTION_REQUIRED"
  | "PROVIDER_WINDOW_REQUIRED"
  | "UNSUPPORTED";

export type ProviderCapabilityDeclaration = {
  provider: SocialProviderId;
  capability: SocialCapability;
  /** Static product truth — independent of env configuration. */
  baseline: CapabilityAvailability;
  notes?: string;
};

/**
 * LinkedIn restricted communication APIs — server-only, NOT user-settable.
 * Must remain false until LinkedIn officially approves the product use case.
 */
export function linkedInInvitationsApiApproved(): boolean {
  return process.env.LINKEDIN_INVITATIONS_API_APPROVED === "true" && process.env.ALLOW_LINKEDIN_RESTRICTED_APIS === "1";
}

export function linkedInConnectionsApiApproved(): boolean {
  return process.env.LINKEDIN_CONNECTIONS_API_APPROVED === "true" && process.env.ALLOW_LINKEDIN_RESTRICTED_APIS === "1";
}

export function linkedInMessagesApiApproved(): boolean {
  return process.env.LINKEDIN_MESSAGES_API_APPROVED === "true" && process.env.ALLOW_LINKEDIN_RESTRICTED_APIS === "1";
}

/** Declared matrix — configuration presence checked separately at call sites. */
export const SOCIAL_PROVIDER_CAPABILITY_MATRIX: ProviderCapabilityDeclaration[] = [
  // Ayrshare
  { provider: "AYRSHARE", capability: "CONNECT_ACCOUNT", baseline: "AVAILABLE" },
  { provider: "AYRSHARE", capability: "PUBLISH", baseline: "AVAILABLE" },
  { provider: "AYRSHARE", capability: "SCHEDULE", baseline: "AVAILABLE" },
  { provider: "AYRSHARE", capability: "ANALYTICS", baseline: "AVAILABLE" },
  { provider: "AYRSHARE", capability: "HISTORY", baseline: "AVAILABLE" },
  { provider: "AYRSHARE", capability: "COMMENTS", baseline: "AVAILABLE" },
  { provider: "AYRSHARE", capability: "DIRECT_MESSAGES", baseline: "AVAILABLE", notes: "Only where network + auth mode permits" },
  { provider: "AYRSHARE", capability: "PROFILE_LOOKUP", baseline: "AVAILABLE", notes: "Only for connected/authenticated modes" },
  { provider: "AYRSHARE", capability: "DISCOVERY", baseline: "UNSUPPORTED", notes: "Broad discovery uses research engine, not Ayrshare as sole people-search" },
  { provider: "AYRSHARE", capability: "CONNECTION_INVITE", baseline: "UNSUPPORTED" },
  { provider: "AYRSHARE", capability: "CONNECTION_STATUS", baseline: "UNSUPPORTED" },
  { provider: "AYRSHARE", capability: "CONVERSATION_READ", baseline: "AVAILABLE", notes: "Where provider supports inbox sync" },
  { provider: "AYRSHARE", capability: "CONVERSATION_WRITE", baseline: "AVAILABLE", notes: "Must still use dispatchOutboundMessage for Inbox" },

  // Meta Instagram native (existing)
  { provider: "META_INSTAGRAM", capability: "CONNECT_ACCOUNT", baseline: "AVAILABLE" },
  { provider: "META_INSTAGRAM", capability: "DIRECT_MESSAGES", baseline: "AVAILABLE", notes: "24h window / contactability rules apply" },
  { provider: "META_INSTAGRAM", capability: "CONVERSATION_READ", baseline: "AVAILABLE" },
  { provider: "META_INSTAGRAM", capability: "CONVERSATION_WRITE", baseline: "AVAILABLE" },
  { provider: "META_INSTAGRAM", capability: "PUBLISH", baseline: "UNSUPPORTED", notes: "Publishing via SocialConnection / Ayrshare" },
  { provider: "META_INSTAGRAM", capability: "DISCOVERY", baseline: "UNSUPPORTED" },
  { provider: "META_INSTAGRAM", capability: "CONNECTION_INVITE", baseline: "UNSUPPORTED" },

  // ManyChat
  { provider: "MANYCHAT", capability: "CONNECT_ACCOUNT", baseline: "AVAILABLE" },
  { provider: "MANYCHAT", capability: "DIRECT_MESSAGES", baseline: "AVAILABLE" },
  { provider: "MANYCHAT", capability: "CONVERSATION_READ", baseline: "AVAILABLE" },
  { provider: "MANYCHAT", capability: "CONVERSATION_WRITE", baseline: "AVAILABLE" },
  { provider: "MANYCHAT", capability: "DISCOVERY", baseline: "UNSUPPORTED" },
  { provider: "MANYCHAT", capability: "PUBLISH", baseline: "UNSUPPORTED" },

  // LinkedIn native — V2 surfaces exist but default REQUIRES_PROVIDER_APPROVAL
  { provider: "LINKEDIN_NATIVE", capability: "CONNECT_ACCOUNT", baseline: "AVAILABLE", notes: "OAuth for publish/profile where already implemented via SocialConnection" },
  { provider: "LINKEDIN_NATIVE", capability: "PUBLISH", baseline: "AVAILABLE", notes: "Existing SocialConnection publish path" },
  { provider: "LINKEDIN_NATIVE", capability: "CONNECTION_INVITE", baseline: "REQUIRES_PROVIDER_APPROVAL" },
  { provider: "LINKEDIN_NATIVE", capability: "CONNECTION_STATUS", baseline: "REQUIRES_PROVIDER_APPROVAL" },
  { provider: "LINKEDIN_NATIVE", capability: "CONVERSATION_READ", baseline: "REQUIRES_PROVIDER_APPROVAL" },
  { provider: "LINKEDIN_NATIVE", capability: "CONVERSATION_WRITE", baseline: "REQUIRES_PROVIDER_APPROVAL" },
  { provider: "LINKEDIN_NATIVE", capability: "DIRECT_MESSAGES", baseline: "REQUIRES_PROVIDER_APPROVAL" },
  { provider: "LINKEDIN_NATIVE", capability: "DISCOVERY", baseline: "UNSUPPORTED", notes: "LinkedIn Marketing API member data must not drive prospect discovery" },
  { provider: "LINKEDIN_NATIVE", capability: "PROFILE_LOOKUP", baseline: "HUMAN_ACTION_REQUIRED", notes: "V1: open LinkedIn URL discovered independently" },
];

export function getDeclaredCapability(
  provider: SocialProviderId,
  capability: SocialCapability,
): ProviderCapabilityDeclaration | undefined {
  return SOCIAL_PROVIDER_CAPABILITY_MATRIX.find(
    (row) => row.provider === provider && row.capability === capability,
  );
}

export function resolveLinkedInCommunicationsAvailability(
  capability: Extract<
    SocialCapability,
    "CONNECTION_INVITE" | "CONNECTION_STATUS" | "CONVERSATION_READ" | "CONVERSATION_WRITE" | "DIRECT_MESSAGES"
  >,
): CapabilityAvailability {
  const approved =
    capability === "CONNECTION_INVITE"
      ? linkedInInvitationsApiApproved()
      : capability === "CONNECTION_STATUS"
        ? linkedInConnectionsApiApproved()
        : linkedInMessagesApiApproved();
  return approved ? "AVAILABLE" : "REQUIRES_PROVIDER_APPROVAL";
}

export class SocialCapabilityBlockedError extends Error {
  code: CapabilityAvailability;
  provider: SocialProviderId;
  capability: SocialCapability;

  constructor(input: {
    provider: SocialProviderId;
    capability: SocialCapability;
    code: CapabilityAvailability;
    message?: string;
  }) {
    super(
      input.message ||
        `${input.provider}.${input.capability} is ${input.code}`,
    );
    this.name = "SocialCapabilityBlockedError";
    this.code = input.code;
    this.provider = input.provider;
    this.capability = input.capability;
  }
}
