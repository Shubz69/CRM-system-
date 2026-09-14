import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { requirePlatformAccess } from "@/lib/session";
import { getAiProvider } from "@/adapters/ai";
import { getMessagingAdapter } from "@/adapters/messaging";
import { getBookingProvider } from "@/adapters/booking";
import { getRuntimeMode } from "@/lib/runtime";
import IORedis from "ioredis";

export const dynamic = "force-dynamic";

type HealthStatus = "Operational" | "Degraded" | "Disconnected" | "Error" | "Not Configured";

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; error?: string; value?: T }> {
  const start = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - start, value };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, error: e instanceof Error ? e.message : "Error" };
  }
}

async function loadZernioWebhookCounts() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return prisma.webhookEvent.groupBy({
    by: ["status"],
    where: { provider: "ZERNIO", createdAt: { gte: weekAgo } },
    _count: { _all: true },
  });
}

export default async function AdminHealthPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/home");
  }

  const env = getEnv();
  const runtime = getRuntimeMode();

  const db = await timed(() => prisma.$queryRaw`SELECT 1`);
  const redis = await timed(async () => {
    const client = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      lazyConnect: true,
    });
    await client.connect();
    const pong = await client.ping();
    await client.quit().catch(() => undefined);
    if (pong !== "PONG") throw new Error("Unexpected ping");
    return true;
  });

  const ai = getAiProvider();
  const messaging = getMessagingAdapter(true);
  const booking = getBookingProvider();

  const failedJobs = await prisma.failedJob.count({ where: { resolvedAt: null } });
  const lastFailure = await prisma.failedJob.findFirst({
    where: { resolvedAt: null },
    orderBy: { createdAt: "desc" },
  });
  const lastWebhookOk = await prisma.webhookEvent.findFirst({
    where: { status: "PROCESSED" },
    orderBy: { processedAt: "desc" },
  });
  const zernioWebhookCounts = await loadZernioWebhookCounts();
  const zernioWebhookSummary = zernioWebhookCounts
    .map((row) => `${row.status} ${row._count._all}`)
    .join(", ");
  const placeholderChannels = await prisma.messagingChannel.count({
    where: { instagramUsername: "demo_account" },
  });

  function statusFor(opts: {
    configured: boolean;
    liveOk?: boolean;
    degraded?: boolean;
  }): HealthStatus {
    if (!opts.configured) return "Not Configured";
    if (opts.degraded) return "Degraded";
    if (opts.liveOk === false) return "Error";
    return "Operational";
  }

  const rows: Array<{
    name: string;
    status: HealthStatus;
    latency?: string;
    lastSuccess?: string;
    lastFailure?: string;
    summary: string;
  }> = [
    {
      name: "Application",
      status: "Operational",
      summary: `Runtime ${runtime}`,
    },
    {
      name: "Database",
      status: db.ok ? "Operational" : "Error",
      latency: `${db.ms}ms`,
      lastSuccess: db.ok ? new Date().toISOString() : undefined,
      lastFailure: db.error,
      summary: db.ok ? "Postgres reachable via Prisma" : db.error || "Unreachable",
    },
    {
      name: "Authentication",
      status: env.AUTH_SECRET || env.NEXTAUTH_SECRET ? "Operational" : "Not Configured",
      summary: "NextAuth credentials JWT",
    },
    {
      name: "Supabase",
      status: env.DATABASE_URL?.includes("supabase")
        ? db.ok
          ? "Operational"
          : "Error"
        : "Not Configured",
      summary: env.DATABASE_URL?.includes("pooler.supabase.com")
        ? "Using Supabase pooler"
        : env.DATABASE_URL?.includes("supabase")
          ? "Supabase URL detected"
          : "Not using Supabase URI",
    },
    {
      name: "Storage",
      status: "Not Configured",
      summary: "Supabase Storage not wired in this app yet",
    },
    {
      name: "Realtime",
      status: "Not Configured",
      summary: "Supabase Realtime not wired in this app yet",
    },
    {
      name: "Anthropic (Claude)",
      status: !env.ANTHROPIC_API_KEY
        ? "Not Configured"
        : ai.name === "anthropic" || ai.name === "mock"
          ? "Operational"
          : ai.name === "not_configured"
            ? "Error"
            : "Degraded",
      summary: env.ANTHROPIC_API_KEY
        ? `Primary AI · adapter ${ai.name} · models via ANTHROPIC_*_MODEL`
        : "ANTHROPIC_API_KEY missing — required for production AI",
    },
    {
      name: "OpenAI (optional)",
      status: env.OPENAI_API_KEY ? "Operational" : "Not Configured",
      summary: "Optional adapter only — not required for Agent Desk",
    },
    {
      name: "Groq (optional)",
      status: env.GROQ_API_KEY ? "Operational" : "Not Configured",
      summary: "Optional free-tier adapter only — not required. See docs/AI_PROVIDERS.md",
    },
    {
      name: "Mistral (optional)",
      status: env.MISTRAL_API_KEY ? "Operational" : "Not Configured",
      summary: "Optional adapter only — not required. See docs/AI_PROVIDERS.md",
    },
    {
      name: "DeepSeek (optional)",
      status: env.DEEPSEEK_API_KEY ? "Operational" : "Not Configured",
      summary: "Optional adapter only — not required. See docs/AI_PROVIDERS.md",
    },
    {
      name: "Gemini (optional, chat)",
      status: env.GEMINI_API_KEY ? "Operational" : "Not Configured",
      summary: env.GEMINI_API_KEY
        ? "Optional adapter — shares GEMINI_API_KEY with image generation"
        : "Optional adapter only — not required. See docs/AI_PROVIDERS.md",
    },
    {
      name: "Apify (social listening)",
      status: !env.APIFY_TOKEN
        ? "Not Configured"
        : "Operational",
      summary: env.APIFY_TOKEN
        ? "Instagram/LinkedIn/TikTok/Twitter-X/Threads keyword search via licensed Apify actors"
        : "APIFY_TOKEN missing — those research sources throw a clear not-configured error, never fake data",
    },
    {
      name: "Zernio (workspace social)",
      status: env.ZERNIO_API_KEY
        ? env.ZERNIO_WEBHOOK_SECRET
          ? "Operational"
          : "Degraded"
        : "Not Configured",
      summary: env.ZERNIO_API_KEY
        ? env.ZERNIO_WEBHOOK_SECRET
          ? `Workspace Instagram/LinkedIn/YouTube connect + publish go through Zernio. Native OAuth rows below are a separate path.${zernioWebhookSummary ? ` Last 7d webhooks: ${zernioWebhookSummary}.` : ""}${placeholderChannels ? ` ${placeholderChannels} MessagingChannel row(s) still have placeholder handle demo_account — not the live @handle.` : ""}`
          : "ZERNIO_API_KEY present but ZERNIO_WEBHOOK_SECRET missing — webhooks fail closed. Connect/publish can still work."
        : "ZERNIO_API_KEY missing — workspace Social Accounts connect is unavailable.",
    },
    {
      name: "Instagram native OAuth",
      status:
        env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET && env.INSTAGRAM_REDIRECT_URI
          ? "Operational"
          : "Not Configured",
      summary:
        env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET && env.INSTAGRAM_REDIRECT_URI
          ? "Meta App credentials set — optional native Graph connect/publish. Independent of Zernio workspace connections."
          : "Native OAuth missing INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_REDIRECT_URI. Workspace Instagram may still be Connected via Zernio. Listening uses Apify above.",
    },
    {
      name: "LinkedIn native OAuth",
      status:
        env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REDIRECT_URI
          ? "Operational"
          : "Not Configured",
      summary:
        env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REDIRECT_URI
          ? "LinkedIn app credentials set — optional native personal-profile OAuth. Independent of Zernio. Messaging is not supported (no compliant API)."
          : "Native OAuth missing LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_REDIRECT_URI. Workspace LinkedIn may still be Connected via Zernio. Listening uses Apify above. Messaging is not supported (no compliant API).",
    },
    {
      name: "TikTok native OAuth",
      status:
        env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET && env.TIKTOK_REDIRECT_URI
          ? "Operational"
          : "Not Configured",
      summary:
        env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET && env.TIKTOK_REDIRECT_URI
          ? "TikTok for Developers credentials set — Content Posting API connect + publish available. Messaging is not supported (no official API)."
          : "Native OAuth missing TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI — Integrations will not show a TikTok Connect button until these are set. Public listen uses Apify above. Messaging is not supported (no official API).",
    },
    {
      name: "ManyChat",
      status: !env.MANYCHAT_API_TOKEN
        ? "Not Configured"
        : messaging.name === "manychat"
          ? "Operational"
          : messaging.name === "mock"
            ? "Degraded"
            : "Error",
      summary:
        messaging.name === "manychat"
          ? "Live ManyChat send adapter selected — not Zernio workspace connect, and not proof inbound webhooks succeed. WEBHOOK_RECEIVE stays AUTH_REQUIRED until the org webhook secret is set. Zernio IGNORED/FAILED events are a separate inbox path."
          : messaging.name === "mock"
            ? "Mock adapter (non-production only)"
            : "Not configured — production will not send",
    },
    {
      name: "Booking Provider",
      status: statusFor({
        configured: Boolean(env.DEFAULT_BOOKING_URL) || Boolean(env.BOOKING_PROVIDER),
      }),
      summary: `Adapter ${booking.name}${env.DEFAULT_BOOKING_URL ? " · URL configured" : ""}`,
    },
    {
      name: "Background Jobs",
      status: redis.ok
        ? failedJobs > 0
          ? "Degraded"
          : "Operational"
        : runtime === "production"
          ? "Disconnected"
          : "Degraded",
      latency: redis.ok ? `${redis.ms}ms` : undefined,
      lastFailure: lastFailure?.error,
      lastSuccess: lastWebhookOk?.processedAt?.toISOString(),
      summary: redis.ok
        ? `Redis reachable · queues: follow-ups, agent-runs, maintenance · ${failedJobs} open failures${
            lastFailure?.error
              ? ` · latest: ${lastFailure.error.slice(0, 180)}${
                  /prisma/i.test(lastFailure.error)
                    ? " (Prisma — research worker persist/query can fail even when Redis is up)"
                    : ""
                }`
              : ""
          }`
        : runtime === "production"
          ? `Redis REQUIRED and unavailable — worker/long jobs will fail · ${failedJobs} open failures`
          : `Redis unavailable — in-process follow-up fallback only (agent-runs + maintenance inactive) · ${failedJobs} open failures`,
    },
    {
      name: "Email Provider",
      status: statusFor({ configured: Boolean(env.EMAIL_SMTP_URL) }),
      summary: env.EMAIL_SMTP_URL ? "SMTP configured" : "Not configured",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">System health</h1>
        <p className="mt-1 text-[var(--muted)]">
          Safe probes only — secrets are never displayed. Status is not inferred from env alone when a check fails.
        </p>
      </div>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-3 py-3">Service</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Latency</th>
              <th className="px-3 py-3">Last success</th>
              <th className="px-3 py-3">Last failure</th>
              <th className="px-3 py-3">Summary</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-b border-[var(--border)]/60 align-top">
                <td className="px-3 py-3 font-medium">{row.name}</td>
                <td className="px-3 py-3">
                  <span
                    className={
                      row.status === "Operational"
                        ? "badge"
                        : row.status === "Not Configured"
                          ? "badge"
                          : "badge badge-warn"
                    }
                  >
                    {row.status}
                  </span>
                </td>
                <td className="px-3 py-3 text-[var(--muted)]">{row.latency || "—"}</td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">{row.lastSuccess || "—"}</td>
                <td className="max-w-xs truncate px-3 py-3 text-xs text-[var(--danger)]">
                  {row.lastFailure || "—"}
                </td>
                <td className="px-3 py-3 text-[var(--muted)]">{row.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
