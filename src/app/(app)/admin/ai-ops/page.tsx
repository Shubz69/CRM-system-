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

type EnterpriseOpsPanel = {
  slo?: {
    maturityNote?: string;
    indicators?: {
      outboxLag?: { pendingCount?: number; deadLetterCount?: number };
      workerFreshness?: { lastAgentRunFinishedAgeMs?: number | null };
    };
  };
  quality?: {
    publishHealth?: {
      rate?: number | null;
      publishedCount?: number;
      failedCount?: number;
    };
  };
  ssoScim?: { maturity?: string };
  productionHealth?: {
    maturity?: string;
    ok?: boolean;
    outboxLag?: { pendingCount?: number; deadLetterCount?: number };
  } | null;
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
  enterpriseOps?: EnterpriseOpsPanel | null;
  queuePrefix?: string | null;
  topology?: unknown;
  queueOps?: unknown;
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
            <Link className="btn btn-secondary" href="/api/admin/production-health">
              Production health
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
            <h2 className="text-lg font-semibold">Enterprise ops (Phase 18)</h2>
            <p className="text-xs text-[var(--muted)]">
              SLO indicators are FOUNDATION — not contractual. Counts from live tables only;
              no invented charts or uptime %.
            </p>
            {data.enterpriseOps ? (
              <div className="grid gap-3 md:grid-cols-3">
                <article className="surface p-4 text-sm space-y-1">
                  <p className="font-medium">SLO snapshot</p>
                  <span className="badge">FOUNDATION</span>
                  <ul className="text-[var(--muted)] mt-1 space-y-0.5">
                    <li>
                      Outbox pending:{" "}
                      {data.enterpriseOps.slo?.indicators?.outboxLag?.pendingCount ?? "—"}
                    </li>
                    <li>
                      Outbox DLQ:{" "}
                      {data.enterpriseOps.slo?.indicators?.outboxLag?.deadLetterCount ?? "—"}
                    </li>
                    <li>
                      Worker freshness (ms):{" "}
                      {data.enterpriseOps.slo?.indicators?.workerFreshness
                        ?.lastAgentRunFinishedAgeMs ?? "null"}
                    </li>
                  </ul>
                </article>
                <article className="surface p-4 text-sm space-y-1">
                  <p className="font-medium">Publish health</p>
                  <ul className="text-[var(--muted)] mt-1 space-y-0.5">
                    <li>
                      Success rate:{" "}
                      {data.enterpriseOps.quality?.publishHealth?.rate == null
                        ? "null (no terminal jobs)"
                        : `${(data.enterpriseOps.quality.publishHealth.rate * 100).toFixed(0)}%`}
                    </li>
                    <li>
                      Published / failed:{" "}
                      {data.enterpriseOps.quality?.publishHealth?.publishedCount ?? 0} /{" "}
                      {data.enterpriseOps.quality?.publishHealth?.failedCount ?? 0}
                    </li>
                  </ul>
                </article>
                <article className="surface p-4 text-sm space-y-1">
                  <p className="font-medium">Quality / identity</p>
                  <p className="text-[var(--muted)] text-xs">
                    Calibration & eval: use Learning + evaluation services (hit-rate when samples
                    exist). SSO/SCIM:{" "}
                    {data.enterpriseOps.ssoScim?.maturity ?? "FOUNDATION"} stubs only.
                  </p>
                  <Link className="text-xs underline" href="/learning">
                    Open Learning
                  </Link>
                </article>
                <article className="surface p-4 text-sm space-y-1">
                  <p className="font-medium">Production health</p>
                  <span className="badge">
                    {data.enterpriseOps.productionHealth?.maturity ?? "FOUNDATION"}
                  </span>
                  <ul className="text-[var(--muted)] mt-1 space-y-0.5">
                    <li>
                      OK:{" "}
                      {data.enterpriseOps.productionHealth?.ok == null
                        ? "—"
                        : String(data.enterpriseOps.productionHealth.ok)}
                    </li>
                    <li>
                      Outbox pending:{" "}
                      {data.enterpriseOps.productionHealth?.outboxLag?.pendingCount ?? "—"}
                    </li>
                    <li>
                      Outbox DLQ:{" "}
                      {data.enterpriseOps.productionHealth?.outboxLag?.deadLetterCount ??
                        "—"}
                    </li>
                  </ul>
                  <Link className="text-xs underline" href="/api/admin/production-health">
                    Full health JSON
                  </Link>
                </article>
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">Enterprise ops panel unavailable.</p>
            )}
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
