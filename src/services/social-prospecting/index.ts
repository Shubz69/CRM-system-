export {
  parseProspectIntent,
  buildProspectDedupeKey,
  normalizeLinkedInUrl,
  normalizeInstagramUrl,
  mergeDiscoveryCostLimits,
  DEFAULT_DISCOVERY_COST_LIMITS,
} from "@/services/social-prospecting/types";
export { qualityCheckProspect, dedupeProspectBatch } from "@/services/social-prospecting/quality";
export {
  discoverSocialProspects,
  listSocialProspects,
  getSocialProspectForOrg,
  listRecentSearchRuns,
} from "@/services/social-prospecting/discovery";
export { gatherProspectCandidatesFromResearch } from "@/services/social-prospecting/research-bridge";
export {
  validateProspectCandidate,
  isPlausibleHumanName,
  isScrapedFragment,
  shouldPersistCompany,
} from "@/services/social-prospecting/entity-validation";
export {
  resolveIdentitiesForCandidate,
  verifyProfileAgainstCandidate,
  detectNetworkFromUrl,
  applyIdentitiesToCandidate,
} from "@/services/social-prospecting/identity-resolver";
export { ingestProspectToCrm } from "@/services/social-prospecting/crm-ingest";
export {
  generateOutreachDrafts,
  prepareProspectOutreach,
  markOutreachState,
  buildActionSurfacesForProspect,
} from "@/services/social-prospecting/outreach";
export {
  universalOutreachSurface,
  listSocialMessagingProviders,
  registerSocialMessagingProvider,
  ensureDefaultMessagingProvidersRegistered,
  selectProviderForCapability,
} from "@/services/social-prospecting/provider-router";
export {
  resolveProviderPlatformCapability,
  platformSupportsCapability,
} from "@/services/social-prospecting/capabilities";
export {
  SOCIAL_PROVIDER,
  SOCIAL_CAPABILITY,
  SOCIAL_PROVIDER_CAPABILITY_MATRIX,
  getDeclaredCapability,
  resolveLinkedInCommunicationsAvailability,
  linkedInInvitationsApiApproved,
  linkedInConnectionsApiApproved,
  linkedInMessagesApiApproved,
  SocialCapabilityBlockedError,
} from "@/services/social-prospecting/capabilities";
export {
  sendConnectionInvitation,
  getInvitationStatus,
  listAuthenticatedUserConnections,
  sendLinkedInMessage,
  replyToLinkedInConversation,
  getLinkedInConversation,
  linkedInV1ActionSurface,
  linkedInV2ActionSurface,
} from "@/services/social-prospecting/linkedin-native";
