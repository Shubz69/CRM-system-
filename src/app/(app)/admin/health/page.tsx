import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { requirePlatformAccess } from "@/lib/session";
import IORedis from "ioredis";

export const dynamic = "force-dynamic";

async function checkRedis(): Promise<"ok" | "degraded" | "down"> {
  try {
    const env = getEnv();
    const redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      lazyConnect: true,
    });
    await redis.connect();
    const pong = await redis.ping();
    await redis.quit().catch(() => undefined);
    return pong === "PONG" ? "ok" : "degraded";
  } catch {
    return "degraded";
  }
}

export default async function AdminHealthPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  let database: "ok" | "down" = "down";
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = "ok";
  } catch {
    database = "down";
  }

  const redis = await checkRedis();
  const env = getEnv();

  const [failedJobs, recentFailures, usageLast24h] = await Promise.all([
    prisma.failedJob.count({ where: { resolvedAt: null } }),
    prisma.failedJob.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.usageRecord.count({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }),
  ]);

  const checks = [
    { name: "Database", status: database },
    { name: "Redis", status: redis },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">System health</h1>
        <p className="mt-1 text-[var(--muted)]">Infrastructure status and failed background jobs.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {checks.map((c) => (
          <div key={c.name} className="surface p-5">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{c.name}</p>
            <p className="mt-2 font-[family-name:var(--font-fraunces)] text-2xl capitalize">{c.status}</p>
          </div>
        ))}
        <div className="surface p-5">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Open failed jobs</p>
          <p className="mt-2 font-[family-name:var(--font-fraunces)] text-2xl">{failedJobs}</p>
        </div>
        <div className="surface p-5">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Usage (24h)</p>
          <p className="mt-2 font-[family-name:var(--font-fraunces)] text-2xl">{usageLast24h}</p>
        </div>
      </div>
      <div className="surface p-5">
        <h2 className="h-display text-2xl">Runtime</h2>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-[var(--muted)]">Node env</dt>
            <dd>{env.NODE_ENV}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">AI provider</dt>
            <dd>{env.AI_PROVIDER}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Demo mode</dt>
            <dd>{env.DEMO_MODE ? "enabled" : "disabled"}</dd>
          </div>
        </dl>
      </div>
      <div className="surface overflow-x-auto">
        <h2 className="h-display border-b border-[var(--border)] px-4 py-3 text-2xl">Recent failed jobs</h2>
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">Queue</th>
              <th className="px-4 py-3">Job</th>
              <th className="px-4 py-3">Error</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {recentFailures.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-[var(--muted)]" colSpan={5}>
                  No open failed jobs.
                </td>
              </tr>
            ) : (
              recentFailures.map((job) => (
                <tr key={job.id} className="border-b border-[var(--border)]/60">
                  <td className="px-4 py-3">{job.queue}</td>
                  <td className="px-4 py-3">{job.jobName}</td>
                  <td className="max-w-md truncate px-4 py-3 text-[var(--danger)]">{job.error}</td>
                  <td className="px-4 py-3">{job.attempts}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{job.createdAt.toISOString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
