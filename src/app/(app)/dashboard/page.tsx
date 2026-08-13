"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { AutopilotPanel } from "@/components/autopilot-panel";
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

function MetricCard({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: string | number;
  href?: string;
  hint?: string;
}) {
  const inner = (
    <>
      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="metric-value mt-2 text-3xl">{value}</p>
      {hint && <p className="mt-2 text-xs text-[var(--muted)]">{hint}</p>}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="surface surface-interactive block p-4">
        {inner}
      </Link>
    );
  }
  return <div className="surface p-4">{inner}</div>;
}

function EmptyHint({ title, ctaHref, ctaLabel }: { title: string; ctaHref: string; ctaLabel: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)]/50 p-4 text-sm">
      <p className="text-[var(--muted)]">{title}</p>
      <Link href={ctaHref} className="btn btn-secondary mt-3">
        {ctaLabel}
      </Link>
    </div>
  );
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preset, setPreset] = useState<"all" | "7" | "30" | "custom">("all");

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const name = session?.user?.name?.split(" ")[0] || "there";
    if (hour < 12) return `Good morning, ${name}`;
    if (hour < 18) return `Good afternoon, ${name}`;
    return `Good evening, ${name}`;
  }, [session?.user?.name]);

  async function load(nextFrom = from, nextTo = to) {
    setError(null);
    try {
      const r = await fetch(
        `/api/dashboard?from=${encodeURIComponent(nextFrom)}&to=${encodeURIComponent(nextTo)}`,
      );
      if (!r.ok) throw new Error((await r.json()).error || "Failed to load");
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyPreset(next: "all" | "7" | "30" | "custom") {
    setPreset(next);
    if (next === "all") {
      setFrom("");
      setTo("");
      void load("", "");
      return;
    }
    if (next === "custom") return;
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (next === "7" ? 7 : 30));
    const f = start.toISOString().slice(0, 10);
    const t = end.toISOString().slice(0, 10);
    setFrom(f);
    setTo(t);
    void load(f, t);
  }

  if (error) {
    return (
      <div className="surface p-6">
        <p className="text-[var(--danger)]">{error}</p>
        <button className="btn btn-secondary mt-3" type="button" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-16 w-2/3" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton h-24" />
          ))}
        </div>
      </div>
    );
  }

  const m = data.metrics;
  const empty = m.totalConversations === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-[var(--muted)]">{greeting}</p>
          <h1 className="h-display text-4xl">What is my AI doing?</h1>
          <p className="mt-1 text-[var(--muted)]">
            {session?.user?.organisationName || "Workspace"} · Autopilot status, exceptions, and results
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.demoMode && <span className="badge badge-warn">Demo mode</span>}
          <Link href="/attention" className="btn btn-secondary">
            Needs Attention
          </Link>
          <Link href="/simulator" className="btn btn-primary">
            Test conversation
          </Link>
        </div>
      </div>

      <AutopilotPanel compact />

      {empty && (
        <div className="surface p-5">
          <p className="font-[family-name:var(--font-fraunces)] text-2xl">
            Start from Home — tell us what you need
          </p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Research a topic, connect Instagram for DMs, or generate a report. You do not need to
            configure models or agents first.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/ask" className="btn btn-primary">
              Go to Home
            </Link>
            <Link href="/settings/go-live" className="btn btn-secondary">
              Connect Instagram
            </Link>
          </div>
        </div>
      )}

      <div className="surface flex flex-wrap items-center gap-2 p-3">
        {(
          [
            ["all", "All time"],
            ["7", "Last 7 days"],
            ["30", "Last 30 days"],
            ["custom", "Custom"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={preset === key ? "btn btn-primary" : "btn btn-secondary"}
            onClick={() => applyPreset(key)}
          >
            {label}
          </button>
        ))}
        {preset === "custom" && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
          >
            <label className="text-sm">
              From
              <input className="input mt-1" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-sm">
              To
              <input className="input mt-1" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <button className="btn btn-secondary" type="submit">
              Apply
            </button>
          </form>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard label="Conversations" value={m.totalConversations} href="/inbox" />
        <MetricCard label="Qualified leads" value={m.qualifiedLeads} href="/pipeline" />
        <MetricCard label="Confirmed bookings" value={m.callsBooked} href="/reports" />
        <MetricCard
          label="Booking rate"
          value={formatPercent(m.leadToBookingConversionRate)}
          hint="Qualified → booked"
        />
        <MetricCard label="AI handled" value={m.aiHandledConversations} href="/agent" />
        <MetricCard
          label="Human handovers"
          value={formatPercent(m.humanTakeoverRate)}
          href="/inbox"
          hint="Share of conversations needing humans"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="surface p-5 lg:col-span-2">
          <h2 className="h-display text-2xl">Pipeline overview</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {[
              ["New", data.funnel.newLeads],
              ["Engaged", data.funnel.engaged],
              ["Qualified", data.funnel.qualified],
              ["Booked", data.funnel.booked],
            ].map(([label, value]) => (
              <Link
                key={String(label)}
                href="/pipeline"
                className="rounded-2xl bg-[var(--surface-2)] p-4 transition hover:bg-[color-mix(in_oklab,var(--accent-soft)_70%,var(--surface-2))]"
              >
                <p className="text-xs uppercase text-[var(--muted)]">{label}</p>
                <p className="metric-value mt-2 text-2xl">{value as number}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="surface p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="h-display text-2xl">Needs attention</h2>
            <Link href="/attention" className="text-sm text-[var(--accent)]">
              Queue
            </Link>
          </div>
          <ul className="mt-4 space-y-3">
            {data.needsAttention.length === 0 && (
              <li className="text-sm text-[var(--muted)]">No conversations need review.</li>
            )}
            {data.needsAttention.map((c) => (
              <li key={c.id}>
                <Link href={`/inbox?c=${c.id}`} className="block rounded-xl p-2 hover:bg-[var(--surface-2)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{c.name || "Unknown"}</span>
                    <span className="badge">{c.score}</span>
                  </div>
                  <p className="line-clamp-1 text-sm text-[var(--muted)]">{c.preview}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="surface p-5">
          <div className="flex items-center justify-between">
            <h2 className="h-display text-2xl">Top objections</h2>
            <Link href="/insights" className="text-sm text-[var(--accent)]">
              Insights
            </Link>
          </div>
          <ul className="mt-4 space-y-2">
            {data.topObjections.length === 0 && (
              <li className="text-sm text-[var(--muted)]">
                Objections appear after conversations are analysed.
              </li>
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
              <li className="text-sm text-[var(--muted)]">
                FAQ themes populate as prospects ask questions.
              </li>
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
              <li className="text-sm text-[var(--muted)]">
                Leads scoring 70+ will appear here.{" "}
                <Link href="/knowledge" className="text-[var(--accent)]">
                  Add knowledge
                </Link>
              </li>
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
