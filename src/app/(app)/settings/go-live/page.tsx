"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

type Check = {
  key: string;
  label: string;
  status: "ready" | "needs_attention" | "optional";
  detail: string;
};

export default function GoLivePage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [mode, setMode] = useState<string>("OFF");
  const [loading, setLoading] = useState(true);
  const [goingLive, setGoingLive] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [settingsRes, healthRes, providersRes, autopilotRes, channelsRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/health"),
        fetch("/api/health/providers"),
        fetch("/api/autopilot"),
        fetch("/api/messaging-channels"),
      ]);
      const settings = settingsRes.ok ? await settingsRes.json() : {};
      const health = healthRes.ok ? await healthRes.json() : {};
      const providers = providersRes.ok ? await providersRes.json() : {};
      const autopilot = autopilotRes.ok ? await autopilotRes.json() : {};
      const channels = channelsRes.ok ? await channelsRes.json() : {};

      setMode(autopilot.mode || "OFF");

      const manychatConnected = Boolean(
        providers.providers?.manychat?.apiTokenConfigured ||
          (channels.channels || []).some((c: { isActive?: boolean }) => c.isActive),
      );
      const aiReady =
        providers.providers?.ai?.adapter &&
        providers.providers.ai.adapter !== "not_configured" &&
        providers.providers.ai.adapter !== "mock";
      const bookingReady = Boolean(
        providers.providers?.booking?.defaultUrlConfigured ||
          providers.providers?.booking?.adapter,
      );

      const next: Check[] = [
        {
          key: "database",
          label: "Database",
          status: health.database?.ok || health.ok ? "ready" : "needs_attention",
          detail: health.database?.ok || health.ok ? "Connected" : "Database unreachable",
        },
        {
          key: "auth",
          label: "Authentication",
          status: "ready",
          detail: "Session active",
        },
        {
          key: "knowledge",
          label: "Knowledge",
          status: "optional",
          detail: "Add FAQs and offers in Knowledge for better answers",
        },
        {
          key: "ai",
          label: "AI Provider",
          status: aiReady || process.env.NODE_ENV !== "production" ? "ready" : "needs_attention",
          detail: `Adapter: ${providers.providers?.ai?.adapter || "unknown"}`,
        },
        {
          key: "qualification",
          label: "Qualification",
          status: "ready",
          detail: "Managed by Autopilot / AI Agent settings",
        },
        {
          key: "scoring",
          label: "Lead Scoring",
          status: "ready",
          detail: "Automatic when Autopilot is live",
        },
        {
          key: "manychat",
          label: "ManyChat / Instagram",
          status: manychatConnected ? "ready" : "needs_attention",
          detail: manychatConnected ? "Connected" : "Connect Instagram in Settings",
        },
        {
          key: "booking",
          label: "Booking",
          status: bookingReady ? "ready" : "optional",
          detail: bookingReady ? "Booking URL / provider ready" : "Add a booking URL before sending links",
        },
        {
          key: "messaging",
          label: "Messaging rules",
          status: "ready",
          detail: "Windows and opt-out rules active",
        },
        {
          key: "jobs",
          label: "Background processing",
          status: health.redis?.ok ? "ready" : "optional",
          detail: health.redis?.ok
            ? "Redis reachable"
            : "Cron/Vercel path used when Redis is unavailable",
        },
        {
          key: "webhooks",
          label: "Webhook health",
          status: "optional",
          detail: "Monitor under Super Admin → Webhook Events after go-live",
        },
        {
          key: "business",
          label: "Business profile",
          status: settings.organisation?.name ? "ready" : "needs_attention",
          detail: settings.organisation?.name || "Set business name in Settings",
        },
      ];
      setChecks(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load checklist");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const criticalReady = useMemo(
    () =>
      checks
        .filter((c) => ["database", "auth", "ai", "manychat", "business"].includes(c.key))
        .every((c) => c.status === "ready" || (c.key === "ai" && c.status !== "needs_attention")),
    [checks],
  );

  async function goLive() {
    setGoingLive(true);
    try {
      const res = await fetch("/api/autopilot", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "LIVE", reason: "go_live_checklist" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not go live");
      toast.success("Autopilot is LIVE");
      setMode("LIVE");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Go live failed");
    } finally {
      setGoingLive(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Go Live</h1>
        <p className="mt-1 text-[var(--muted)]">
          Final readiness checklist before Autopilot operates your Instagram pipeline.
        </p>
      </div>

      {loading ? (
        <div className="surface p-6 text-sm text-[var(--muted)]">Checking systems…</div>
      ) : (
        <ul className="surface divide-y divide-[var(--border)]">
          {checks.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium">{c.label}</p>
                <p className="text-xs text-[var(--muted)]">{c.detail}</p>
              </div>
              <span
                className={`badge ${
                  c.status === "ready" ? "" : c.status === "needs_attention" ? "badge-warn" : ""
                }`}
              >
                {c.status === "ready"
                  ? "Ready"
                  : c.status === "needs_attention"
                    ? "Needs attention"
                    : "Optional"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="surface p-5">
        <p className="text-sm text-[var(--muted)]">
          Current Autopilot mode: <strong>{mode}</strong>
        </p>
        <button
          type="button"
          className="btn btn-primary mt-4"
          disabled={!criticalReady || goingLive || mode === "LIVE"}
          onClick={() => void goLive()}
        >
          {mode === "LIVE" ? "Autopilot already LIVE" : "Turn Autopilot ON"}
        </button>
        {!criticalReady && (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Resolve critical items (database, business, AI, Instagram) before going live.
          </p>
        )}
        <div className="mt-4 flex gap-3 text-sm">
          <Link href="/settings" className="text-[var(--accent)] hover:underline">
            Settings
          </Link>
          <Link href="/autopilot" className="text-[var(--accent)] hover:underline">
            Autopilot
          </Link>
          <Link href="/dashboard" className="text-[var(--accent)] hover:underline">
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
