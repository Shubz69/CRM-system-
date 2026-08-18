import { getEnv } from "@/lib/env";
import { getAiProvider } from "@/adapters/ai";
import { getMessagingAdapter } from "@/adapters/messaging";
import { getBookingProvider } from "@/adapters/booking";
import { listConfiguredSourcePlatforms } from "@/adapters/sources";

export async function GET() {
  const env = getEnv();
  const ai = getAiProvider();
  const messaging = getMessagingAdapter();
  const booking = getBookingProvider();

  return Response.json({
    ok: true,
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
        // Optional secondary/free-tier providers — never required, see docs/AI_PROVIDERS.md.
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
      },
      booking: {
        provider: env.BOOKING_PROVIDER,
        adapter: booking.name,
        webhookSecretConfigured: Boolean(env.BOOKING_WEBHOOK_SECRET),
        defaultUrlConfigured: Boolean(env.DEFAULT_BOOKING_URL),
      },
      email: {
        smtpConfigured: Boolean(env.EMAIL_SMTP_URL),
        fromConfigured: Boolean(env.EMAIL_FROM),
      },
    },
    timestamp: new Date().toISOString(),
  });
}
