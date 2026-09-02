/**
 * Extensible social messaging / account-provider interface.
 * Prospect discovery does NOT depend on these adapters (Zernio/Ayrshare optional).
 */

import type { CapabilityAvailability, SocialCapability, SocialProviderId } from "@/services/social-prospecting/capabilities";
import { SOCIAL_PROVIDER, getDeclaredCapability } from "@/services/social-prospecting/capabilities";

export type SocialMessagingNetwork =
  | "LINKEDIN"
  | "INSTAGRAM"
  | "X"
  | "TIKTOK"
  | "YOUTUBE"
  | "FACEBOOK"
  | "THREADS"
  | "OTHER";

export type OutreachActionSurface = {
  network: SocialMessagingNetwork;
  openLabel: string;
  copyActions: Array<{ id: string; label: string; field: "connectionNote" | "followUpOne" | "followUpTwo" | "generic" }>;
  sendMessage?: boolean;
  note?: string;
};

export type SocialMessagingProviderAdapter = {
  readonly id: SocialProviderId | string;
  readonly displayName: string;
  isConfigured(): boolean;
  supportsNetwork(network: SocialMessagingNetwork): boolean;
  capability(capability: SocialCapability): CapabilityAvailability;
  sendDirectMessage?(input: {
    organisationId: string;
    network: SocialMessagingNetwork;
    recipientExternalId: string;
    body: string;
  }): Promise<{ ok: boolean; providerMessageId?: string; error?: string }>;
};

const registry = new Map<string, SocialMessagingProviderAdapter>();

export function registerSocialMessagingProvider(adapter: SocialMessagingProviderAdapter): void {
  registry.set(String(adapter.id), adapter);
}

export function listSocialMessagingProviders(): SocialMessagingProviderAdapter[] {
  return [...registry.values()];
}

export function getSocialMessagingProvider(id: string): SocialMessagingProviderAdapter | undefined {
  return registry.get(id);
}

/** Capability-first selection — prefers Zernio when configured, never vendors blindly. */
export function selectProviderForCapability(input: {
  capability: SocialCapability;
  network: SocialMessagingNetwork;
}): SocialMessagingProviderAdapter | null {
  ensureDefaultMessagingProvidersRegistered();
  const preferredOrder: string[] = [
    SOCIAL_PROVIDER.ZERNIO,
    SOCIAL_PROVIDER.META_INSTAGRAM,
    SOCIAL_PROVIDER.MANYCHAT,
    SOCIAL_PROVIDER.AYRSHARE,
    SOCIAL_PROVIDER.LINKEDIN_NATIVE,
  ];
  for (const id of preferredOrder) {
    const adapter = registry.get(id);
    if (!adapter?.isConfigured()) continue;
    if (!adapter.supportsNetwork(input.network)) continue;
    const avail = adapter.capability(input.capability);
    if (avail === "AVAILABLE" || avail === "PROVIDER_WINDOW_REQUIRED") return adapter;
  }
  return null;
}

export function universalOutreachSurface(network: SocialMessagingNetwork): OutreachActionSurface {
  switch (network) {
    case "LINKEDIN":
      return {
        network,
        openLabel: "Open LinkedIn",
        copyActions: [
          { id: "copy_connection", label: "Copy Connection Note", field: "connectionNote" },
          { id: "copy_followup", label: "Copy Follow-up DM", field: "followUpOne" },
        ],
        sendMessage: false,
        note: "LinkedIn send requires official provider approval (V2) — Zernio does not enable LinkedIn DMs",
      };
    case "INSTAGRAM":
      return {
        network,
        openLabel: "Open Instagram",
        copyActions: [{ id: "copy_dm", label: "Copy DM", field: "connectionNote" }],
        sendMessage: false,
        note: "Send Message only when an existing permitted conversation exists via dispatchOutboundMessage",
      };
    case "YOUTUBE":
      return {
        network,
        openLabel: "Open YouTube Channel",
        copyActions: [{ id: "copy_outreach", label: "Copy Outreach", field: "generic" }],
        sendMessage: false,
        note: "YouTube Direct Messages are unsupported",
      };
    default:
      return {
        network,
        openLabel: "Open Profile",
        copyActions: [{ id: "copy_outreach", label: "Copy Outreach", field: "generic" }],
        sendMessage: false,
      };
  }
}

export const optionalZernioMessagingAdapter: SocialMessagingProviderAdapter = {
  id: SOCIAL_PROVIDER.ZERNIO,
  displayName: "Zernio",
  isConfigured() {
    return Boolean(process.env.ZERNIO_API_KEY?.trim());
  },
  supportsNetwork(network) {
    if (!this.isConfigured()) return false;
    // LinkedIn / YouTube DMs not supported through Zernio — connect/publish only
    if (network === "LINKEDIN" || network === "YOUTUBE") return true;
    return network === "INSTAGRAM" || network === "FACEBOOK" || network === "X" || network === "TIKTOK";
  },
  capability(capability) {
    if (capability === "DIRECT_MESSAGES" || capability === "CONVERSATION_WRITE") {
      // Network-specific: callers must also check platformSupportsCapability(LINKEDIN)=false
      return getDeclaredCapability("ZERNIO", capability)?.baseline || "UNSUPPORTED";
    }
    return getDeclaredCapability("ZERNIO", capability)?.baseline || "UNSUPPORTED";
  },
};

export const optionalAyrshareMessagingAdapter: SocialMessagingProviderAdapter = {
  id: SOCIAL_PROVIDER.AYRSHARE,
  displayName: "Ayrshare",
  isConfigured() {
    return Boolean(process.env.AYRSHARE_API_KEY?.trim());
  },
  supportsNetwork() {
    return this.isConfigured();
  },
  capability(capability) {
    return getDeclaredCapability("AYRSHARE", capability)?.baseline || "UNSUPPORTED";
  },
};

export function ensureDefaultMessagingProvidersRegistered(): void {
  if (!registry.has(SOCIAL_PROVIDER.ZERNIO)) {
    registerSocialMessagingProvider(optionalZernioMessagingAdapter);
  }
  if (!registry.has(SOCIAL_PROVIDER.AYRSHARE)) {
    registerSocialMessagingProvider(optionalAyrshareMessagingAdapter);
  }
}
