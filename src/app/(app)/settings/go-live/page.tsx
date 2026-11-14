"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import {
  bookingCheck,
  businessProfileCheck,
  messagingRulesCheck,
  qualificationCheck,
  scoringCheck,
  type GoLiveAgentConfig,
  type GoLiveCheck as Check,
} from "./checklist";

export default function GoLivePage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [mode, setMode] = useState<string>("OFF");
  const [loading, setLoading] = useState(true);
  const [goingLive, setGoingLive] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [
        settingsRes,
        healthRes,
        providersRes,
        autopilotRes,
        channelsRes,
        dbRes,
        agentRes,
        qualificationRes,
        businessRes,
      ] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/health"),
        fetch("/api/health/providers"),
        fetch("/api/autopilot"),
        fetch("/api/messaging-channels"),
        fetch("/api/health/database"),
        fetch("/api/agent"),
        fetch("/api/qualification-fields"),
        fetch("/api/business-context"),
      ]);
      const settings = settingsRes.ok ? await settingsRes.json() : {};
      // Health may return 503 when Redis is down — still read the body.
      const health = await healthRes.json().catch(() => ({}));
      const providers = providersRes.ok ? await providersRes.json() : {};
      const autopilot = autopilotRes.ok ? await autopilotRes.json() : {};
      if (channelsRes.ok) await channelsRes.json();
      const dbHealth = await dbRes.json().catch(() => ({}));
      // undefined = couldn't load; null = no active agent configuration.
      const agent: GoLiveAgentConfig = agentRes.ok
        ? ((await agentRes.json().catch(() => ({}))).config ?? null)
        : undefined;
      const qualificationFieldCount: number | null = qualificationRes.ok
        ? ((await qualificationRes.json().catch(() => ({}))).fields?.length ?? 0)
        : null;
      const business = businessRes.ok ? await businessRes.json().catch(() => null) : null;
      const productCount: number | null = Array.isArray(business?.profile?.products)
        ? business.profile.products.length
        : null;
      const audienceCount: number | null = Array.isArray(business?.profile?.audiences)
        ? business.profile.audiences.length
        : null;

      setMode(autopilot.mode || "OFF");

      const socialRes = await fetch("/api/integrations/zernio");
      const social = socialRes.ok ? await socialRes.json() : {};
      const instagramConnected = Boolean(social.networks?.instagram?.connected);
      const aiReady =
        Boolean(providers.providers?.ai?.ready) ||
        providers.providers?.ai?.status === "AVAILABLE";
      // Customers get booking.ready (= DEFAULT_BOOKING_URL set); platform viewers get defaultUrlConfigured.
      const defaultBookingUrlConfigured = Boolean(
        providers.providers?.booking?.ready || providers.providers?.booking?.defaultUrlConfigured,
      );

      const databaseOk = Boolean(
        dbHealth.ok ||
          health.database?.ok ||
          health.checks?.database === "ok",
      );
      const redisOk = Boolean(health.redis?.ok || health.checks?.redis === "ok");

      const next: Check[] = [
        {
          key: "database",
          label: "Database",
          status: databaseOk ? "ready" : "needs_attention",
          detail: databaseOk ? "Connected" : "Database unreachable",
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
          label: "Agent Desk intelligence",
          status: aiReady ? "ready" : "needs_attention",
          detail: aiReady ? "Available" : "Unavailable — contact support",
        },
        qualificationCheck({ agent, qualificationFieldCount }),
        scoringCheck(agent),
        {
          key: "instagram",
          label: "Instagram",
          status: instagramConnected ? "ready" : "needs_attention",
          detail: instagramConnected
            ? "Connected"
            : "Connect Instagram in Social Accounts (Integrations)",
        },
        bookingCheck({ agent, defaultBookingUrlConfigured }),
        messagingRulesCheck(agent),
        {
          key: "jobs",
          label: "Hosted worker + Redis",
          status: redisOk ? "ready" : "needs_attention",
          detail: redisOk
            ? "Redis reachable — keep `npm run worker` running on Railway/Render for DEEP Ask (QUICK Ask is in-process and does not wait on the worker)"
            : "Redis down — DEEP Ask cannot queue. QUICK Ask still runs in the web process.",
        },
        {
          key: "webhooks",
          label: "Webhook health",
          status: "optional",
          detail: "Monitor under Super Admin → Webhook Events after go-live",
        },
        businessProfileCheck({
          organisationName: settings.organisation?.name,
          productCount,
          audienceCount,
        }),
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
        .filter((c) =>
          ["database", "auth", "ai", "instagram", "business", "jobs"].includes(c.key),
        )
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
      <PageHeader description="Final readiness checklist before Autopilot operates your Instagram pipeline." />

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
