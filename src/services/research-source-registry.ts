/**
 * Research / integration capability matrix — real credential + adapter status.
 * Distinguishes: connected/configured vs unavailable vs unsupported.
 */

import { getEnv } from "@/lib/env";
import {
  listConfiguredSourcePlatforms,
  listSourceAdapters,
  type SourcePlatform,
} from "@/adapters/sources";

export type CapabilityStatus =
  | "configured"
  | "requires_credentials"
  | "unsupported"
  | "degraded";

export type CapabilityId =
  | "search_public"
  | "read_owned_content"
  | "publish"
  | "schedule"
  | "analytics"
  | "webhooks";

export type PlatformCapabilityRow = {
  platform: string;
  displayName: string;
  category: "research_source" | "messaging" | "social_oauth" | "booking" | "ai";
  capabilities: Record<CapabilityId, CapabilityStatus>;
  notes: string;
  credentialHint: string | null;
};

const RESEARCH_CAPS: CapabilityId[] = [
  "search_public",
  "read_owned_content",
  "publish",
  "schedule",
  "analytics",
  "webhooks",
];

function researchRow(
  platform: SourcePlatform,
  displayName: string,
  configured: boolean,
  credentialHint: string,
  notes: string,
): PlatformCapabilityRow {
  const search: CapabilityStatus = configured ? "configured" : "requires_credentials";
  const caps = Object.fromEntries(
    RESEARCH_CAPS.map((id) => {
      if (id === "search_public") return [id, search];
      return [id, "unsupported" as CapabilityStatus];
    }),
  ) as Record<CapabilityId, CapabilityStatus>;

  return {
    platform,
    displayName,
    category: "research_source",
    capabilities: caps,
    notes,
    credentialHint: configured ? null : credentialHint,
  };
}

export function buildIntegrationCapabilityMatrix(): {
  generatedAt: string;
  platforms: PlatformCapabilityRow[];
} {
  const env = getEnv();
  const configured = new Set(listConfiguredSourcePlatforms());
  const adapters = listSourceAdapters();

  const byPlatform = new Map(adapters.map((a) => [a.platform, a.displayName]));

  const research: PlatformCapabilityRow[] = (
    [
      ["youtube", "YouTube", "YOUTUBE_API_KEY", "Public video search via Data API."],
      ["reddit", "Reddit", "REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET", "Public post search."],
      [
        "web",
        "Web search",
        "TAVILY_API_KEY or EXA_API_KEY",
        `Provider: ${(env.WEB_SEARCH_PROVIDER || "tavily").toLowerCase()}.`,
      ],
      ["instagram", "Instagram (Apify)", "APIFY_TOKEN", "Public search via Apify when token set."],
      ["linkedin", "LinkedIn (Apify)", "APIFY_TOKEN", "Public search via Apify when token set."],
      ["tiktok", "TikTok (Apify)", "APIFY_TOKEN", "Public search via Apify when token set."],
      ["twitter", "Twitter/X (Apify)", "APIFY_TOKEN", "Public search via Apify when token set."],
      ["threads", "Threads (Apify)", "APIFY_TOKEN", "Public search via Apify when token set."],
    ] as const
  ).map(([platform, name, hint, notes]) =>
    researchRow(
      platform,
      byPlatform.get(platform) || name,
      configured.has(platform),
      hint,
      notes,
    ),
  );

  const messaging: PlatformCapabilityRow = {
    platform: "manychat",
    displayName: "ManyChat",
    category: "messaging",
    capabilities: {
      search_public: "unsupported",
      read_owned_content: env.MANYCHAT_API_TOKEN ? "configured" : "requires_credentials",
      publish: "unsupported",
      schedule: "unsupported",
      analytics: "unsupported",
      webhooks: env.MANYCHAT_WEBHOOK_SECRET ? "configured" : "requires_credentials",
    },
    notes: "Outbound DM / inbox. Mock transport used when token missing.",
    credentialHint: env.MANYCHAT_API_TOKEN ? null : "MANYCHAT_API_TOKEN",
  };

  const socialOauth: PlatformCapabilityRow[] = (
    [
      ["instagram_oauth", "Instagram (OAuth publish)"],
      ["linkedin_oauth", "LinkedIn (OAuth publish)"],
      ["tiktok_oauth", "TikTok (OAuth publish)"],
    ] as const
  ).map(([platform, displayName]) => ({
    platform,
    displayName,
    category: "social_oauth" as const,
    capabilities: {
      search_public: "unsupported" as CapabilityStatus,
      read_owned_content: "requires_credentials" as CapabilityStatus,
      publish: "requires_credentials" as CapabilityStatus,
      schedule: "requires_credentials" as CapabilityStatus,
      analytics: "unsupported" as CapabilityStatus,
      webhooks: "unsupported" as CapabilityStatus,
    },
    notes: "Per-org SocialConnection OAuth — status is connection-specific, not env-global.",
    credentialHint: "Connect under Settings → Social",
  }));

  const booking: PlatformCapabilityRow = {
    platform: "booking",
    displayName: "Booking (Cal.com / Calendly)",
    category: "booking",
    capabilities: {
      search_public: "unsupported",
      read_owned_content: "unsupported",
      publish: "unsupported",
      schedule: env.DEFAULT_BOOKING_URL ? "configured" : "requires_credentials",
      analytics: "unsupported",
      webhooks: env.BOOKING_WEBHOOK_SECRET ? "configured" : "requires_credentials",
    },
    notes: "Qualification booking link + inbound booking webhooks.",
    credentialHint: env.DEFAULT_BOOKING_URL ? null : "DEFAULT_BOOKING_URL",
  };

  const aiProvider = (env.AI_PROVIDER || "mock").toLowerCase();
  const aiConfigured =
    aiProvider === "mock" ||
    (aiProvider === "openai" && !!env.OPENAI_API_KEY) ||
    (aiProvider === "anthropic" && !!env.ANTHROPIC_API_KEY) ||
    (aiProvider === "gemini" && !!env.GEMINI_API_KEY) ||
    (aiProvider === "deepseek" && !!env.DEEPSEEK_API_KEY) ||
    (aiProvider === "groq" && !!env.GROQ_API_KEY) ||
    (aiProvider === "mistral" && !!env.MISTRAL_API_KEY);

  const ai: PlatformCapabilityRow = {
    platform: "ai",
    displayName: `AI (${aiProvider})`,
    category: "ai",
    capabilities: {
      search_public: "unsupported",
      read_owned_content: "unsupported",
      publish: "unsupported",
      schedule: "unsupported",
      analytics: "unsupported",
      webhooks: "unsupported",
    },
    notes: aiConfigured
      ? "Primary Ask / agent completions provider."
      : "Primary AI provider credentials missing.",
    credentialHint: aiConfigured ? null : `${aiProvider.toUpperCase()}_API_KEY`,
  };

  return {
    generatedAt: new Date().toISOString(),
    platforms: [...research, messaging, ...socialOauth, booking, ai],
  };
}
