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

export default async function AdminHealthPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
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
      summary: "Optional adapter only — not required for DM Intelligence",
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
          ? "Live adapter selected"
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
        ? `Redis reachable · queues: follow-ups, agent-runs · ${failedJobs} open failures`
        : runtime === "production"
          ? `Redis REQUIRED and unavailable — worker/long jobs will fail · ${failedJobs} open failures`
          : `Redis unavailable — in-process follow-up fallback only (agent-runs inactive) · ${failedJobs} open failures`,
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
