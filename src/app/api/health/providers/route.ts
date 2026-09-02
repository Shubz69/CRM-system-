import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { getAiProvider } from "@/adapters/ai";
import { getMessagingAdapter } from "@/adapters/messaging";
import { getBookingProvider } from "@/adapters/booking";
import { listConfiguredSourcePlatforms } from "@/adapters/sources";
import { getPublicProviderCapabilityHealth } from "@/services/provider-capability-health";
import { customerSafeAiHealth } from "@/lib/customer-ai-errors";

function isPlatformViewer(session: {
  user?: { isPlatformAdmin?: boolean; role?: string };
} | null): boolean {
  const u = session?.user;
  if (!u) return false;
  return Boolean(u.isPlatformAdmin) || u.role === "SUPER_ADMIN";
}

/**
 * Provider capability snapshot.
 * Platform developers get full AI vendor diagnostics.
 * Workspace customers get product-level AI availability only (no Claude/OpenAI/keys).
 */
export async function GET() {
  const env = getEnv();
  let session: { user?: { isPlatformAdmin?: boolean; role?: string } } | null = null;
  try {
    session = await getServerSession(authOptions);
  } catch {
    session = null;
  }
  const platform = isPlatformViewer(session);
  const ai = getAiProvider();
  const messaging = getMessagingAdapter();
  const booking = getBookingProvider();
  const snapshot = getPublicProviderCapabilityHealth();
  const aiReady = Boolean(env.ANTHROPIC_API_KEY) || ai.name === "mock";

  if (!platform) {
    const messagingConfigured = Boolean(env.MANYCHAT_WEBHOOK_SECRET || env.MANYCHAT_API_TOKEN);
    const bookingConfigured = Boolean(env.BOOKING_WEBHOOK_SECRET);
    const emailConfigured = Boolean(env.EMAIL_SMTP_URL);
    return Response.json({
      ok: true,
      providers: {
        ai: customerSafeAiHealth(aiReady),
        research: {
          configuredPlatforms: listConfiguredSourcePlatforms().length > 0,
        },
        messaging: {
          status: messagingConfigured ? "AVAILABLE" : "UNAVAILABLE",
          ready: messagingConfigured,
        },
        booking: {
          status: bookingConfigured ? "AVAILABLE" : "UNAVAILABLE",
          ready: Boolean(env.DEFAULT_BOOKING_URL),
        },
        email: {
          status: emailConfigured ? "AVAILABLE" : "UNAVAILABLE",
          ready: emailConfigured,
        },
      },
      timestamp: new Date().toISOString(),
    });
  }

  return Response.json({
    ok: true,
    ...snapshot,
    legacy: {
      ai: {
        primary: "anthropic",
        label: "Claude",
        configured: env.AI_PROVIDER || "anthropic",
        adapter: ai.name,
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
        hasOpenAiKey: Boolean(env.OPENAI_API_KEY),
        openaiRequired: false,
        ready: aiReady,
        optionalProviders: {
          groq: Boolean(env.GROQ_API_KEY),
          mistral: Boolean(env.MISTRAL_API_KEY),
          deepseek: Boolean(env.DEEPSEEK_API_KEY),
          gemini: Boolean(env.GEMINI_API_KEY),
        },
      },
    },
    providers: {
      ai: {
        primary: "anthropic",
        label: "Claude",
        configured: env.AI_PROVIDER || "anthropic",
        adapter: ai.name,
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
        hasOpenAiKey: Boolean(env.OPENAI_API_KEY),
        openaiRequired: false,
        ready: aiReady,
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
