import { getEnv } from "@/lib/env";
import { getAiProvider } from "@/adapters/ai";
import { getMessagingAdapter } from "@/adapters/messaging";
import { getBookingProvider } from "@/adapters/booking";

export async function GET() {
  const env = getEnv();
  const ai = getAiProvider();
  const messaging = getMessagingAdapter();
  const booking = getBookingProvider();

  return Response.json({
    ok: true,
    providers: {
      ai: {
        configured: env.AI_PROVIDER,
        adapter: ai.name,
        hasOpenAiKey: Boolean(env.OPENAI_API_KEY),
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
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
