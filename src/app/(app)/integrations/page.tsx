"use client";

import { FormEvent, useEffect, useState } from "react";
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
  secretConfigured: boolean;
  secretMasked: string;
  apiTokenConfigured: boolean;
  channels: Channel[];
  connected: boolean;
};

function maskSecret(value: string | undefined | null): string {
  if (!value) return "not set";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export default function IntegrationsPage() {
  const [status, setStatus] = useState<ManyChatStatus | null>(null);
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations/manychat");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setStatus(json);
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

  if (loading && !status) {
    return <div className="surface p-6 text-[var(--muted)]">Loading integrations…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Integrations</h1>
        <p className="mt-1 text-[var(--muted)]">
          Connect messaging channels and review webhook configuration.
        </p>
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
          </div>
          <div>
            <dt className="text-[var(--muted)]">Webhook secret</dt>
            <dd className="mt-1 font-mono text-xs">
              {status?.secretConfigured
                ? status.secretMasked || maskSecret("configured")
                : "not set"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">API token</dt>
            <dd className="mt-1">{status?.apiTokenConfigured ? "Configured" : "Not configured"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Active channels</dt>
            <dd className="mt-1">{status?.channels.filter((c) => c.isActive).length ?? 0}</dd>
          </div>
        </dl>
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
              placeholder="Instagram brand"
            />
          </label>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Add / update channel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
