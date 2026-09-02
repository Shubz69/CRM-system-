/**
 * Safe provider capability health for public/operator surfaces.
 * Never exposes secrets. A configured env key alone never implies CONNECTED/LIVE.
 */

import { getEnv } from "@/lib/env";
import { isMetaInstagramAppConfigured } from "@/services/messaging/meta-instagram";
import { listConfiguredSourcePlatforms } from "@/adapters/sources";

/** Honest readiness — not a live probe unless explicitly noted. */
export type ProviderCapabilityStatus =
  | "NOT_CONFIGURED"
  | "CONFIGURED"
  | "CONNECTED"
  | "DEGRADED"
  | "REAUTH_REQUIRED"
  | "DISCONNECTED";

export type ProviderHealthEntry = {
  id: string;
  label: string;
  /** Env / app credentials present enough to attempt use */
  status: ProviderCapabilityStatus;
  /** Optional nuance — never secrets */
  detail?: string;
  /** True when status reflects live connection health rather than env presence alone */
  liveConnectionAware?: boolean;
};

function envConfigured(value: string | undefined | null): boolean {
  return Boolean(value && String(value).trim());
}

/**
 * Build a public-safe provider capability snapshot.
 * Does not call external providers. Does not read org IntegrationCredential rows
 * (those require auth + org context — see Integrations UI / admin health).
 */
export function getPublicProviderCapabilityHealth(): {
  providers: ProviderHealthEntry[];
  notes: string[];
} {
  const env = getEnv();
  const providers: ProviderHealthEntry[] = [];

  const anthropic = envConfigured(env.ANTHROPIC_API_KEY);
  providers.push({
    id: "anthropic",
    label: "Anthropic (Claude)",
    status: anthropic ? "CONFIGURED" : "NOT_CONFIGURED",
    detail: anthropic
      ? "API key present — not a live connectivity probe"
      : "ANTHROPIC_API_KEY missing",
  });

  providers.push({
    id: "openai",
    label: "OpenAI (optional / embeddings)",
    status: envConfigured(env.OPENAI_API_KEY) ? "CONFIGURED" : "NOT_CONFIGURED",
    detail: "Optional unless embeddings require it",
  });

  const manychatWebhook = envConfigured(env.MANYCHAT_WEBHOOK_SECRET);
  const manychatToken = envConfigured(env.MANYCHAT_API_TOKEN);
  providers.push({
    id: "manychat",
    label: "ManyChat",
    status: manychatWebhook || manychatToken ? "CONFIGURED" : "NOT_CONFIGURED",
    detail:
      "Server webhook/API env presence only — org connection health is separate (CONNECTED/DEGRADED/…)",
    liveConnectionAware: false,
  });

  const metaApp = isMetaInstagramAppConfigured();
  providers.push({
    id: "meta_instagram",
    label: "Meta Instagram (native)",
    status: metaApp ? "CONFIGURED" : "NOT_CONFIGURED",
    detail: metaApp
      ? "App credentials present — org OAuth CONNECTED state is per-workspace"
      : "INSTAGRAM_APP_ID/SECRET (or META_*) not set — optional provider",
    liveConnectionAware: false,
  });

  providers.push({
    id: "booking",
    label: "Booking webhooks",
    status: envConfigured(env.BOOKING_WEBHOOK_SECRET) ? "CONFIGURED" : "NOT_CONFIGURED",
    detail: `Provider adapter: ${env.BOOKING_PROVIDER || "generic"}`,
  });

  const smtp = envConfigured(env.EMAIL_SMTP_URL);
  providers.push({
    id: "smtp",
    label: "Email (SMTP)",
    status: smtp ? "CONFIGURED" : "NOT_CONFIGURED",
    detail: smtp
      ? envConfigured(env.EMAIL_FROM)
        ? "SMTP URL + EMAIL_FROM present"
        : "SMTP URL present but EMAIL_FROM missing — From may be weak"
      : "Invites fall back to copy-link until EMAIL_SMTP_URL is set",
  });

  providers.push({
    id: "tavily",
    label: "Tavily research",
    status: envConfigured(env.TAVILY_API_KEY) ? "CONFIGURED" : "NOT_CONFIGURED",
  });

  providers.push({
    id: "youtube",
    label: "YouTube Data API",
    status: envConfigured(env.YOUTUBE_API_KEY) ? "CONFIGURED" : "NOT_CONFIGURED",
  });

  providers.push({
    id: "apify",
    label: "Apify",
    status: envConfigured(env.APIFY_TOKEN) ? "CONFIGURED" : "NOT_CONFIGURED",
    detail: envConfigured(env.APIFY_TOKEN)
      ? `Source platforms declared: ${listConfiguredSourcePlatforms().join(", ") || "none"}`
      : undefined,
  });

  providers.push({
    id: "zernio",
    label: "Zernio (validation social)",
    status: envConfigured(env.ZERNIO_API_KEY) ? "CONFIGURED" : "NOT_CONFIGURED",
    detail: envConfigured(env.ZERNIO_API_KEY)
      ? envConfigured(env.ZERNIO_WEBHOOK_SECRET)
        ? "API key + webhook secret present — org CONNECTED is per-workspace / per-network"
        : "API key present but ZERNIO_WEBHOOK_SECRET missing — webhooks fail closed"
      : "Optional validation social provider (preferred when configured)",
    liveConnectionAware: false,
  });

  providers.push({
    id: "ayrshare",
    label: "Ayrshare",
    status: envConfigured(env.AYRSHARE_API_KEY) ? "CONFIGURED" : "NOT_CONFIGURED",
    detail: envConfigured(env.AYRSHARE_API_KEY)
      ? "Primary API key present — org profile link is per-workspace (CONNECTED ≠ CONFIGURED)"
      : "Optional social publish/connect provider",
    liveConnectionAware: false,
  });

  const socialPublish: Array<{ id: string; label: string; ok: boolean }> = [
    {
      id: "social_instagram_publish",
      label: "Instagram publish (Graph)",
      ok: envConfigured(env.INSTAGRAM_APP_ID) && envConfigured(env.INSTAGRAM_APP_SECRET),
    },
    {
      id: "social_linkedin",
      label: "LinkedIn",
      ok: envConfigured(env.LINKEDIN_CLIENT_ID) && envConfigured(env.LINKEDIN_CLIENT_SECRET),
    },
    {
      id: "social_tiktok",
      label: "TikTok",
      ok: envConfigured(env.TIKTOK_CLIENT_KEY) && envConfigured(env.TIKTOK_CLIENT_SECRET),
    },
  ];
  for (const s of socialPublish) {
    providers.push({
      id: s.id,
      label: s.label,
      status: s.ok ? "CONFIGURED" : "NOT_CONFIGURED",
      detail: "App credentials only — tenant OAuth CONNECTED is per SocialConnection",
      liveConnectionAware: false,
    });
  }

  return {
    providers,
    notes: [
      "Public health reports env/app configuration presence only.",
      "CONNECTED / DEGRADED / REAUTH_REQUIRED / DISCONNECTED require authenticated org-scoped integration checks.",
      "Optional providers (Meta Instagram, Apify, social publish) must never appear as globally mandatory.",
    ],
  };
}
