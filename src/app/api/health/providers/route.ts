import { getEnv } from "@/lib/env";
import { getAiProvider } from "@/adapters/ai";
import { getMessagingAdapter } from "@/adapters/messaging";
import { getBookingProvider } from "@/adapters/booking";
import { listConfiguredSourcePlatforms } from "@/adapters/sources";
import { getPublicProviderCapabilityHealth } from "@/services/provider-capability-health";

/**
 * Public provider capability snapshot.
 * Safe: no secrets, no live probes, CONFIGURED ≠ CONNECTED.
 * Keeps legacy `providers.{ai,manychat,...}` shape for existing UI plus `capabilities[]`.
 */
export async function GET() {
  const env = getEnv();
  const ai = getAiProvider();
  const messaging = getMessagingAdapter();
  const booking = getBookingProvider();
  const snapshot = getPublicProviderCapabilityHealth();

  return Response.json({
    ok: true,
    ...snapshot,
    /** @deprecated Prefer snapshot.providers entries with status enums */
    legacy: {
      ai: {
        primary: "anthropic",
        label: "Claude",
        configured: env.AI_PROVIDER || "anthropic",
        adapter: ai.name,
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
        hasOpenAiKey: Boolean(env.OPENAI_API_KEY),
        openaiRequired: false,
        ready: Boolean(env.ANTHROPIC_API_KEY) || ai.name === "mock",
        optionalProviders: {
          groq: Boolean(env.GROQ_API_KEY),
          mistral: Boolean(env.MISTRAL_API_KEY),
          deepseek: Boolean(env.DEEPSEEK_API_KEY),
          gemini: Boolean(env.GEMINI_API_KEY),
        },
      },
    },
    // Backward-compatible nested map used by Settings / Go Live / Integrations
    providers: {
      ai: {
        primary: "anthropic",
        label: "Claude",
        configured: env.AI_PROVIDER || "anthropic",
        adapter: ai.name,
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
        hasOpenAiKey: Boolean(env.OPENAI_API_KEY),
        openaiRequired: false,
        ready: Boolean(env.ANTHROPIC_API_KEY) || ai.name === "mock",
        status: env.ANTHROPIC_API_KEY ? "CONFIGURED" : "NOT_CONFIGURED",
        optionalProviders: {
          groq: Boolean(env.GROQ_API_KEY),
          mistral: Boolean(env.MISTRAL_API_KEY),
          deepseek: Boolean(env.DEEPSEEK_API_KEY),
          gemini: Boolean(env.GEMINI_API_KEY),
        },
      },
      research: {
        apifyConfigured: Boolean(env.APIFY_TOKEN),
        configuredPlatforms: listConfiguredSourcePlatforms(),
      },
      manychat: {
        webhookSecretConfigured: Boolean(env.MANYCHAT_WEBHOOK_SECRET),
        apiTokenConfigured: Boolean(env.MANYCHAT_API_TOKEN),
        adapter: messaging.name,
        status: env.MANYCHAT_WEBHOOK_SECRET || env.MANYCHAT_API_TOKEN ? "CONFIGURED" : "NOT_CONFIGURED",
      },
      booking: {
        provider: env.BOOKING_PROVIDER,
        adapter: booking.name,
        webhookSecretConfigured: Boolean(env.BOOKING_WEBHOOK_SECRET),
        defaultUrlConfigured: Boolean(env.DEFAULT_BOOKING_URL),
        status: env.BOOKING_WEBHOOK_SECRET ? "CONFIGURED" : "NOT_CONFIGURED",
      },
      email: {
        smtpConfigured: Boolean(env.EMAIL_SMTP_URL),
        fromConfigured: Boolean(env.EMAIL_FROM),
        status: env.EMAIL_SMTP_URL ? "CONFIGURED" : "NOT_CONFIGURED",
      },
      ayrshare: {
        apiKeyConfigured: Boolean(env.AYRSHARE_API_KEY),
        status: env.AYRSHARE_API_KEY ? "CONFIGURED" : "NOT_CONFIGURED",
      },
      meta_instagram: {
        status: snapshot.providers.find((p) => p.id === "meta_instagram")?.status || "NOT_CONFIGURED",
      },
      capabilities: snapshot.providers,
    },
    notes: snapshot.notes,
    timestamp: new Date().toISOString(),
  });
}
