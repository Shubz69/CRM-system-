"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

type Channel = {
  id: string;
  provider: string;
  externalId: string | null;
  displayName: string;
  instagramUsername: string | null;
  isActive: boolean;
};

type ManyChatStatus = {
  webhookUrl: string;
  inboundAliasUrl?: string;
  secretConfigured: boolean;
  secretMasked: string;
  secretSource?: string;
  apiTokenConfigured: boolean;
  apiTokenMasked?: string;
  channels: Channel[];
  connected: boolean;
  lastInboundEvent?: {
    id: string;
    eventType: string | null;
    status: string;
    receivedAt: string;
  } | null;
  recentErrors?: Array<{ id: string; error: string | null; status: string; receivedAt: string }>;
  setup?: {
    requiredHeaders: string[];
    requiredFields: string[];
    optionalFields: string[];
    examplePayload: Record<string, unknown>;
  };
};

export default function IntegrationsPage() {
  const [status, setStatus] = useState<ManyChatStatus | null>(null);
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiReady, setAiReady] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [res, providersRes] = await Promise.all([
        fetch("/api/integrations/manychat"),
        fetch("/api/health/providers"),
      ]);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setStatus(json);
      if (providersRes.ok) {
        const p = await providersRes.json();
        setAiReady(Boolean(p.providers?.ai?.ready || p.providers?.ai?.hasAnthropicKey));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function saveChannel(e: FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/messaging-channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "manychat",
        externalId,
        displayName: displayName || externalId,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Save failed");
      return;
    }
    toast.success("Messaging channel saved");
    setExternalId("");
    setDisplayName("");
    await load();
  }

  async function runAction(action: "regenerate_secret" | "test_inbound" | "test_outbound") {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/manychat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Action failed");
      if (action === "regenerate_secret" && json.secret) {
        setOneTimeSecret(json.secret);
        toast.success("Secret regenerated — copy it now");
      } else {
        toast.success(action === "test_inbound" ? "Test inbound processed" : "Test outbound sent");
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy");
    }
  }

  if (loading && !status) {
    return <div className="surface p-6 text-[var(--muted)]">Loading integrations…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Integrations</h1>
        <p className="mt-1 text-[var(--muted)]">
          Connect Instagram, Calendar, and your AI Operator (Claude).
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Instagram</h2>
            <span className={status?.connected ? "badge" : "badge badge-warn"}>
              {status?.connected ? "Connected" : "Not Connected"}
            </span>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">ManyChat Instagram DMs</p>
        </div>
        <div className="surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Calendar</h2>
            <span className="badge">Booking URL</span>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">Manage in AI Operator / Settings</p>
          <Link href="/agent" className="btn btn-secondary mt-3">
            Manage
          </Link>
        </div>
        <div className="surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">AI Operator</h2>
            <span className={aiReady ? "badge" : "badge badge-warn"}>
              {aiReady ? "Claude Connected" : "Claude Needs Setup"}
            </span>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">Anthropic Claude — OpenAI not required</p>
          <Link href="/agent" className="btn btn-secondary mt-3">
            Manage
          </Link>
        </div>
      </div>

      <section className="surface space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="h-display text-2xl">ManyChat</h2>
            <p className="text-sm text-[var(--muted)]">Instagram DM ingestion via ManyChat webhooks.</p>
          </div>
          <span className={status?.connected ? "badge badge-success" : "badge badge-warn"}>
            {status?.connected ? "Connected" : "Not connected"}
          </span>
        </div>
        <dl className="grid gap-3 text-sm md:grid-cols-2">
          <div>
            <dt className="text-[var(--muted)]">Webhook URL</dt>
            <dd className="mt-1 break-all font-mono text-xs">{status?.webhookUrl || "—"}</dd>
            {status?.webhookUrl && (
              <button type="button" className="btn btn-secondary mt-2" onClick={() => copy(status.webhookUrl)}>
                Copy URL
              </button>
            )}
          </div>
          <div>
            <dt className="text-[var(--muted)]">Inbound alias</dt>
            <dd className="mt-1 break-all font-mono text-xs">{status?.inboundAliasUrl || "—"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Webhook secret</dt>
            <dd className="mt-1 font-mono text-xs">
              {status?.secretConfigured ? status.secretMasked : "not set"}
              {status?.secretSource ? ` (${status.secretSource})` : ""}
            </dd>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => runAction("regenerate_secret")}
              >
                Regenerate secret
              </button>
            </div>
            {oneTimeSecret && (
              <p className="mt-2 rounded-lg bg-[var(--surface-2)] p-2 font-mono text-xs">
                New secret (shown once): {oneTimeSecret}
                <button type="button" className="btn btn-secondary ml-2" onClick={() => copy(oneTimeSecret)}>
                  Copy
                </button>
              </p>
            )}
          </div>
          <div>
            <dt className="text-[var(--muted)]">API token</dt>
            <dd className="mt-1">{status?.apiTokenMasked || (status?.apiTokenConfigured ? "Configured" : "Not configured")}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Last inbound event</dt>
            <dd className="mt-1 text-xs">
              {status?.lastInboundEvent
                ? `${status.lastInboundEvent.status} · ${new Date(status.lastInboundEvent.receivedAt).toLocaleString()}`
                : "None yet"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Active channels</dt>
            <dd className="mt-1">{status?.channels.filter((c) => c.isActive).length ?? 0}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => runAction("test_inbound")}>
            Test inbound webhook
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => runAction("test_outbound")}>
            Test outbound message
          </button>
        </div>
        {(status?.recentErrors?.length || 0) > 0 && (
          <div>
            <h3 className="font-semibold">Recent errors</h3>
            <ul className="mt-2 space-y-1 text-xs text-[var(--danger)]">
              {status?.recentErrors?.map((e) => (
                <li key={e.id}>
                  {e.status}: {e.error || "unknown"} · {new Date(e.receivedAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        )}
        {status?.setup && (
          <details className="rounded-xl border border-[var(--border)] p-3 text-sm">
            <summary className="cursor-pointer font-medium">ManyChat setup instructions</summary>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-[var(--muted)]">
              <li>Create an External Request or Dynamic Block in ManyChat.</li>
              <li>POST to the webhook URL with header <code>x-manychat-secret</code>.</li>
              <li>Include <code>subscriber_id</code> and <code>text</code> (or <code>message</code>).</li>
              <li>Pass <code>organisationId</code> or map <code>channel_id</code> to a messaging channel.</li>
              <li>Use the regenerated org secret or the environment secret.</li>
            </ol>
            <p className="mt-3 text-xs text-[var(--muted)]">Required fields: {status.setup.requiredFields.join(", ")}</p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--surface-2)] p-3 text-xs">
              {JSON.stringify(status.setup.examplePayload, null, 2)}
            </pre>
          </details>
        )}
      </section>

      <section className="surface space-y-4 p-5">
        <h2 className="h-display text-2xl">Booking webhooks</h2>
        <p className="text-sm text-[var(--muted)]">
          Confirmed bookings arrive separately from booking-link offers. Use these endpoints with header{" "}
          <code>x-booking-secret</code>.
        </p>
        <ul className="space-y-2 text-sm font-mono text-xs">
          <li>/api/webhooks/booking</li>
          <li>/api/integrations/booking/calendly/webhook</li>
          <li>/api/integrations/booking/calcom/webhook</li>
        </ul>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Messaging channels</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {(status?.channels || []).length === 0 && (
            <li className="text-[var(--muted)]">No channels configured yet.</li>
          )}
          {(status?.channels || []).map((ch) => (
            <li key={ch.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)]/50 py-2">
              <div>
                <p className="font-medium">{ch.displayName}</p>
                <p className="text-[var(--muted)]">
                  {ch.provider} · {ch.externalId || "no external id"}
                  {ch.instagramUsername ? ` · @${ch.instagramUsername}` : ""}
                </p>
              </div>
              <span className={ch.isActive ? "badge badge-success" : "badge"}>{ch.isActive ? "Active" : "Inactive"}</span>
            </li>
          ))}
        </ul>
        <form onSubmit={saveChannel} className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            External ID
            <input
              className="input mt-1"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              required
              placeholder="page or bot id"
            />
          </label>
          <label className="text-sm">
            Display name
            <input
              className="input mt-1"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Instagram page"
            />
          </label>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Save channel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
