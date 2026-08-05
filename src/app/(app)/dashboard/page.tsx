"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatPercent } from "@/lib/utils";

type DashboardData = {
  demoMode?: boolean;
  metrics: {
    totalConversations: number;
    newLeads: number;
    qualifiedLeads: number;
    disqualifiedLeads: number;
    callsBooked: number;
    bookingConversionRate: number;
    leadToBookingConversionRate: number;
    aiHandledConversations: number;
    humanTakeoverRate: number;
    followUpsSent: number;
  };
  topObjections: Array<{ category: string; count: number }>;
  topQuestions: Array<{ text: string; count: number }>;
  highValueLeads: Array<{ id: string; name: string | null; score: number; stage?: string }>;
  needsAttention: Array<{ id: string; name: string | null; preview: string | null; score: number }>;
  funnel: { newLeads: number; engaged: number; qualified: number; booked: number };
};

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="surface p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="mt-2 font-[family-name:var(--font-fraunces)] text-3xl">{value}</p>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboard")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Failed to load");
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return <div className="surface p-6 text-[var(--danger)]">{error}</div>;
  }

  if (!data) {
    return <div className="surface p-6 text-[var(--muted)]">Loading dashboard…</div>;
  }

  const m = data.metrics;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h-display text-4xl">Dashboard</h1>
          <p className="mt-1 text-[var(--muted)]">Live metrics from your organisation database.</p>
        </div>
        {data.demoMode && <span className="badge badge-warn">Demo data mode enabled</span>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Conversations" value={m.totalConversations} />
        <MetricCard label="New leads" value={m.newLeads} />
        <MetricCard label="Qualified" value={m.qualifiedLeads} />
        <MetricCard label="Disqualified" value={m.disqualifiedLeads} />
        <MetricCard label="Calls booked" value={m.callsBooked} />
        <MetricCard label="Lead → booking" value={formatPercent(m.leadToBookingConversionRate)} />
        <MetricCard label="AI handled" value={m.aiHandledConversations} />
        <MetricCard label="Human takeover" value={formatPercent(m.humanTakeoverRate)} />
        <MetricCard label="Follow-ups sent" value={m.followUpsSent} />
        <MetricCard label="Booking conversion" value={formatPercent(m.bookingConversionRate)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="surface p-5 lg:col-span-2">
          <h2 className="h-display text-2xl">Funnel</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {[
              ["New", data.funnel.newLeads],
              ["Engaged", data.funnel.engaged],
              ["Qualified", data.funnel.qualified],
              ["Booked", data.funnel.booked],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-2xl bg-[var(--surface-2)] p-4">
                <p className="text-xs uppercase text-[var(--muted)]">{label}</p>
                <p className="mt-2 text-2xl font-semibold">{value as number}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="surface p-5">
          <h2 className="h-display text-2xl">Needs attention</h2>
          <ul className="mt-4 space-y-3">
            {data.needsAttention.length === 0 && (
              <li className="text-sm text-[var(--muted)]">No conversations need review.</li>
            )}
            {data.needsAttention.map((c) => (
              <li key={c.id}>
                <Link href={`/inbox?c=${c.id}`} className="block rounded-xl hover:bg-[var(--surface-2)] p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{c.name || "Unknown"}</span>
                    <span className="badge">{c.score}</span>
                  </div>
                  <p className="text-sm text-[var(--muted)] line-clamp-1">{c.preview}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="surface p-5">
          <h2 className="h-display text-2xl">Top objections</h2>
          <ul className="mt-4 space-y-2">
            {data.topObjections.length === 0 && (
              <li className="text-sm text-[var(--muted)]">No objections detected yet.</li>
            )}
            {data.topObjections.map((o) => (
              <li key={o.category} className="flex justify-between text-sm">
                <span>{o.category}</span>
                <span className="badge">{o.count}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="surface p-5">
          <h2 className="h-display text-2xl">Top questions</h2>
          <ul className="mt-4 space-y-2">
            {data.topQuestions.length === 0 && (
              <li className="text-sm text-[var(--muted)]">No questions aggregated yet.</li>
            )}
            {data.topQuestions.map((q) => (
              <li key={q.text} className="text-sm">
                <span className="line-clamp-2">{q.text}</span>
                <span className="badge mt-1">{q.count}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="surface p-5">
          <h2 className="h-display text-2xl">High-value leads</h2>
          <ul className="mt-4 space-y-2">
            {data.highValueLeads.length === 0 && (
              <li className="text-sm text-[var(--muted)]">No high-score leads yet.</li>
            )}
            {data.highValueLeads.map((l) => (
              <li key={l.id} className="flex items-center justify-between text-sm">
                <span>
                  {l.name || "Lead"} · {l.stage || "—"}
                </span>
                <span className="badge badge-success">{l.score}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
