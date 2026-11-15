"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import {
  bookingCheck,
  businessProfileCheck,
  goLiveAccess,
  instagramCheck,
  messagingRulesCheck,
  NO_ACCESS,
  qualificationCheck,
  scoringCheck,
  type GoLiveAccess,
  type GoLiveAgentConfig,
  type GoLiveCheck as Check,
  type GoLiveManyChatStatus,
  type GoLiveMessagingChannel,
  type GoLiveZernioInstagram,
  type NoAccess,
} from "./checklist";

/** Only call endpoints the role may use; a skipped call resolves to null without a request. */
function fetchIf(allowed: boolean, url: string): Promise<Response | null> {
  return allowed ? fetch(url) : Promise.resolve(null);
}

/**
 * JSON body of a role-gated call: NO_ACCESS when it was skipped for the role (or the server
 * still answered 403), null when it failed or the body could not be read.
 */
async function readAllowed<T>(res: Response | null): Promise<T | null | NoAccess> {
  if (!res || res.status === 403) return NO_ACCESS;
  if (!res.ok) return null;
  return ((await res.json().catch(() => null)) as T | null) ?? null;
}

export default function GoLivePage() {
  const { data: session, status: sessionStatus } = useSession();
  const role = session?.user?.role ?? null;
  const access = useMemo(() => goLiveAccess(role), [role]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [mode, setMode] = useState<string>("OFF");
  const [loading, setLoading] = useState(true);
  const [goingLive, setGoingLive] = useState(false);

  async function load(can: GoLiveAccess) {
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
        socialRes,
        manychatRes,
      ] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/health"),
        fetch("/api/health/providers"),
        fetch("/api/autopilot"),
        fetchIf(can.channels, "/api/messaging-channels"),
        fetch("/api/health/database"),
        fetchIf(can.agent, "/api/agent"),
        fetchIf(can.agent, "/api/qualification-fields"),
        fetchIf(can.businessProfile, "/api/business-context"),
        fetchIf(can.socialAccounts, "/api/integrations/zernio"),
        fetchIf(can.manychat, "/api/integrations/manychat"),
      ]);
      const settings = settingsRes.ok ? await settingsRes.json() : {};
      // Health may return 503 when Redis is down — still read the body.
      const health = await healthRes.json().catch(() => ({}));
      const providers = providersRes.ok ? await providersRes.json() : {};
      const autopilot = autopilotRes.ok ? await autopilotRes.json() : {};
      const channelsBody = await readAllowed<{ channels?: GoLiveMessagingChannel[] }>(channelsRes);
      const channels =
        channelsBody === NO_ACCESS
          ? NO_ACCESS
          : Array.isArray(channelsBody?.channels)
            ? channelsBody.channels
            : null;
      const dbHealth = await dbRes.json().catch(() => ({}));
      // undefined = couldn't load; null = no active agent configuration.
      const agentBody = await readAllowed<{ config?: GoLiveAgentConfig }>(agentRes);
      const agent: GoLiveAgentConfig =
        agentBody === NO_ACCESS ? NO_ACCESS : agentBody ? (agentBody.config ?? null) : undefined;
      // Deactivated fields are kept for history but are not collected — count active ones only.
      const qualificationBody = await readAllowed<{ fields?: Array<{ active?: boolean }> }>(
        qualificationRes,
      );
      const qualificationFieldCount =
        qualificationBody === NO_ACCESS
          ? NO_ACCESS
          : qualificationBody
            ? (qualificationBody.fields ?? []).filter((f) => f.active !== false).length
            : null;
      const business = await readAllowed<{
        profile?: { products?: unknown; audiences?: unknown };
      }>(businessRes);
      const productCount =
        business === NO_ACCESS
          ? NO_ACCESS
          : Array.isArray(business?.profile?.products)
            ? business.profile.products.length
            : null;
      const audienceCount =
        business === NO_ACCESS
          ? NO_ACCESS
          : Array.isArray(business?.profile?.audiences)
            ? business.profile.audiences.length
            : null;

      setMode(autopilot.mode || "OFF");

      const social = await readAllowed<{ networks?: { instagram?: GoLiveZernioInstagram } }>(
        socialRes,
      );
      const manychat = await readAllowed<GoLiveManyChatStatus>(manychatRes);
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
        instagramCheck({
          manychat: manychat as Parameters<typeof instagramCheck>[0]["manychat"],
          channels,
          zernioInstagram:
            social === NO_ACCESS
              ? NO_ACCESS
              : social
                ? ((social as { networks?: { instagram?: object } }).networks?.instagram ?? {})
                : null,
        }),
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

  // Wait for the session so the role is known before any role-gated call goes out.
  useEffect(() => {
    if (sessionStatus === "loading") return;
    void load(access);
  }, [sessionStatus, access]);

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
                    : c.status === "restricted"
                      ? "Not checked"
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
        {sessionStatus === "loading" ? null : access.goLive ? (
          <>
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
          </>
        ) : (
          <p className="mt-2 text-sm text-[var(--muted)]">
            Only workspace owners and admins can turn Autopilot on or off.
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
