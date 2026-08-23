"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

type QueueRow = {
  name: string;
  waiting: number | null;
  active: number | null;
  delayed: number | null;
  failed: number | null;
  ok: boolean;
  error?: string;
};

type Snapshot = {
  redisOk: boolean;
  workerRequiredForAsk: boolean;
  openFailedJobs: number;
  message: string;
  queues: QueueRow[];
  recentFailedJobs: Array<{
    id: string;
    queue: string;
    jobName: string;
    error: string | null;
    createdAt: string;
  }>;
  recentRuns: Array<{
    id: string;
    status: string;
    request: string;
    totalCostCents: number;
    organisationId: string;
    userFacingError: string | null;
  }>;
  recentAiFailures: Array<{
    id: string;
    provider: string;
    model: string;
    taskType: string;
    error: string | null;
  }>;
};

export default function AdminAiOpsPage() {
  const [data, setData] = useState<Snapshot | null>(null);

  useEffect(() => {
    fetch("/api/admin/ai-ops")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Failed");
        setData(j);
      })
      .catch((e) => toast.error(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        description="Real queue depths, failed jobs, and recent AgentRuns — no invented uptime or success rates."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link className="btn btn-secondary" href="/admin/health">
              System Health
            </Link>
            <Link className="btn btn-secondary" href="/admin/failed-jobs">
              Failed Jobs
            </Link>
            <Link className="btn btn-secondary" href="/admin/usage">
              AI Usage
            </Link>
          </div>
        }
      />

      {!data && <p className="text-sm text-[var(--muted)]">Loading…</p>}

      {data && (
        <>
          <section className="surface p-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge">{data.redisOk ? "Redis OK" : "Redis down"}</span>
              {data.workerRequiredForAsk && (
                <span className="badge">Hosted worker required for Ask</span>
              )}
              {"queuePrefix" in data && data.queuePrefix != null && (
                <span className="badge">prefix:{String(data.queuePrefix)}</span>
              )}
            </div>
            <p className="text-sm text-[var(--muted)]">{data.message}</p>
            <p className="text-sm">
              Open failed jobs: <strong>{data.openFailedJobs}</strong>
            </p>
            {"topology" in data && data.topology != null && (
              <p className="text-xs text-[var(--muted)]">
                Topology: 1 BullMQ worker (agent-runs); follow-ups/retention via Postgres
                intervals; cron only if CRON_FALLBACK_ENABLED.
              </p>
            )}
            {"queueOps" in data && data.queueOps != null && (
              <p className="text-xs text-[var(--muted)]">
                Process queue ops (not Upstash billing): refresh loads cached Redis depths
                (30s). See docs/REDIS-COST.md.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Queues</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {data.queues.map((q) => (
                <article key={q.name} className="surface p-4 text-sm space-y-1">
                  <p className="font-medium">{q.name}</p>
                  {!q.ok ? (
                    <p className="text-[var(--muted)]">{q.error || "Unavailable"}</p>
                  ) : (
                    <ul className="text-[var(--muted)]">
                      <li>waiting: {q.waiting}</li>
                      <li>active: {q.active}</li>
                      <li>delayed: {q.delayed}</li>
                      <li>failed: {q.failed}</li>
                    </ul>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Recent AgentRuns</h2>
            {data.recentRuns.length === 0 && (
              <p className="text-sm text-[var(--muted)]">No runs yet.</p>
            )}
            <ul className="space-y-2">
              {data.recentRuns.map((r) => (
                <li key={r.id} className="surface p-3 text-sm">
                  <span className="badge mr-2">{r.status}</span>
                  <span className="text-[var(--muted)]">{r.totalCostCents}¢</span>
                  <p className="mt-1 line-clamp-2">{r.request}</p>
                  {r.userFacingError && (
                    <p className="mt-1 text-xs text-red-600">{r.userFacingError}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Recent failed jobs</h2>
            {data.recentFailedJobs.length === 0 && (
              <p className="text-sm text-[var(--muted)]">None open.</p>
            )}
            <ul className="space-y-2">
              {data.recentFailedJobs.map((j) => (
                <li key={j.id} className="surface p-3 text-sm">
                  <span className="badge mr-2">{j.queue}</span>
                  {j.jobName}
                  {j.error && <p className="mt-1 text-xs text-[var(--muted)] line-clamp-2">{j.error}</p>}
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Recent AI execution failures</h2>
            {data.recentAiFailures.length === 0 && (
              <p className="text-sm text-[var(--muted)]">No recent failures in ledger.</p>
            )}
            <ul className="space-y-2">
              {data.recentAiFailures.map((a) => (
                <li key={a.id} className="surface p-3 text-sm">
                  {a.provider}/{a.model} · {a.taskType}
                  {a.error && <p className="mt-1 text-xs text-[var(--muted)] line-clamp-2">{a.error}</p>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
