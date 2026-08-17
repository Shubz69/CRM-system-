"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

type AutopilotData = {
  mode: "OFF" | "TEST" | "LIVE" | "PAUSED" | "ATTENTION_REQUIRED";
  config: Record<string, string>;
  stats: {
    handledToday: number;
    qualifiedToday: number;
    bookingsToday: number;
    aiActive: number;
    waitingHuman: number;
    attentionErrors: number;
    recentActivity: Array<{
      id: string;
      action: string;
      createdAt: string;
      metadata?: unknown;
    }>;
  };
};

const MODE_LABEL: Record<string, string> = {
  OFF: "OFF",
  TEST: "TEST MODE",
  LIVE: "LIVE",
  PAUSED: "PAUSED",
  ATTENTION_REQUIRED: "ATTENTION REQUIRED",
};

function activityLabel(action: string) {
  const map: Record<string, string> = {
    "autopilot.mode_change": "Autopilot mode changed",
    "lead.qualified": "AI qualified a lead",
    "lead.stage_change": "Lead moved in pipeline",
    "booking.offered": "Booking link sent",
    "booking.created": "Booking confirmed",
    "conversation.handover": "Conversation handed to human",
    "knowledge.gap": "Knowledge gap detected",
  };
  return map[action] || action.replace(/\./g, " ");
}

export function AutopilotPanel({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<AutopilotData | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/autopilot");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load autopilot");
      setData(json);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Autopilot unavailable");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function setMode(mode: AutopilotData["mode"]) {
    try {
      const res = await fetch("/api/autopilot", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Update failed");
      toast.success(`Autopilot ${MODE_LABEL[mode]}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  }

  if (loading && !data) {
    return <div className="surface animate-pulse p-5 text-sm text-[var(--muted)]">Loading Autopilot…</div>;
  }
  if (!data) return null;

  const pulse = data.mode === "LIVE";

  return (
    <section className="surface relative overflow-hidden p-5">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            data.mode === "LIVE"
              ? "radial-gradient(600px 120px at 10% 0%, color-mix(in oklab, var(--accent) 22%, transparent), transparent)"
              : data.mode === "ATTENTION_REQUIRED"
                ? "radial-gradient(600px 120px at 10% 0%, color-mix(in oklab, var(--danger) 16%, transparent), transparent)"
                : "radial-gradient(600px 120px at 10% 0%, color-mix(in oklab, var(--accent-2) 12%, transparent), transparent)",
        }}
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                pulse ? "animate-pulse bg-[var(--accent)]" : "bg-[var(--muted)]"
              }`}
            />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
              Autopilot
            </p>
          </div>
          <h2 className="mt-1 font-[family-name:var(--font-fraunces)] text-3xl tracking-tight">
            {MODE_LABEL[data.mode]}
          </h2>
          <p className="mt-1 max-w-xl text-sm text-[var(--muted)]">
            {data.mode === "LIVE"
              ? "AI is operating the sales pipeline within your safety limits."
              : data.mode === "TEST"
                ? "Simulator and test events only — production Instagram DMs are not auto-replied."
                : data.mode === "PAUSED" || data.mode === "ATTENTION_REQUIRED"
                  ? "Automatic replies are paused. Handle exceptions, then resume."
                  : "Configure once, then turn Autopilot on when you are ready."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["OFF", "TEST", "LIVE", "PAUSED"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`btn ${data.mode === mode ? "btn-primary" : "btn-secondary"} text-xs`}
              onClick={() => void setMode(mode)}
            >
              {MODE_LABEL[mode]}
            </button>
          ))}
          <Link href="/autopilot" className="btn btn-secondary text-xs">
            Settings
          </Link>
        </div>
      </div>

      <div className="relative mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Handled today", value: data.stats.handledToday },
          { label: "Qualified today", value: data.stats.qualifiedToday },
          { label: "Bookings today", value: data.stats.bookingsToday },
          { label: "AI active", value: data.stats.aiActive },
          { label: "Waiting for human", value: data.stats.waitingHuman, href: "/attention" },
          { label: "Errors", value: data.stats.attentionErrors, href: "/attention" },
        ].map((m) => {
          const inner = (
            <>
              <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{m.label}</p>
              <p className="mt-1 text-2xl font-[family-name:var(--font-fraunces)]">{m.value}</p>
            </>
          );
          return m.href ? (
            <Link key={m.label} href={m.href} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/60 p-3">
              {inner}
            </Link>
          ) : (
            <div key={m.label} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/60 p-3">
              {inner}
            </div>
          );
        })}
      </div>

      {!compact && (
        <div className="relative mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Recent AI activity
          </h3>
          <ul className="mt-2 space-y-2">
            {data.stats.recentActivity.length === 0 ? (
              <li className="text-sm text-[var(--muted)]">
                Activity will appear as Autopilot handles conversations.
              </li>
            ) : (
              data.stats.recentActivity.slice(0, 8).map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 border-b border-[var(--border)]/40 py-2 text-sm"
                >
                  <span>{activityLabel(a.action)}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {new Date(a.createdAt).toLocaleTimeString()}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
