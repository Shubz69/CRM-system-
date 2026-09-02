/**
 * Extensible social messaging / account-provider interface.
 * Prospect discovery does NOT depend on these adapters (Ayrshare is optional).
 * New cheap providers (Buffer, Postiz, etc.) implement this as adapters — no schema redesign.
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
  /** Only when a permitted provider conversation exists — never for arbitrary cold DM */
  sendMessage?: boolean;
  note?: string;
};

export type SocialMessagingProviderAdapter = {
  readonly id: SocialProviderId | string;
  readonly displayName: string;
  isConfigured(): boolean;
  supportsNetwork(network: SocialMessagingNetwork): boolean;
  capability(capability: SocialCapability): CapabilityAvailability;
  /**
   * Optional: send via provider when rules allow.
   * Cold outreach must NOT call this — use Open/Copy surfaces instead.
   */
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

/** Universal Open/Copy UX — independent of which messaging provider is configured. */
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
        note: "LinkedIn send requires official provider approval (V2)",
      };
    case "INSTAGRAM":
      return {
        network,
        openLabel: "Open Instagram",
        copyActions: [{ id: "copy_dm", label: "Copy DM", field: "connectionNote" }],
        sendMessage: false,
        note: "Send Message only when an existing permitted conversation exists via dispatchOutboundMessage",
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

/** Stub optional Ayrshare-shaped adapter — registration is optional; absence must not break prospecting. */
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

/** Call once from app boot / tests if desired — prospecting core never requires it. */
export function ensureDefaultMessagingProvidersRegistered(): void {
  if (!registry.has(SOCIAL_PROVIDER.AYRSHARE)) {
    registerSocialMessagingProvider(optionalAyrshareMessagingAdapter);
  }
}
