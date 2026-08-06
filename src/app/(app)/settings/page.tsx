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

type Member = {
  id: string;
  role: string;
  user: { email: string; name: string | null };
};

type OrgInfo = {
  name?: string;
  slug?: string;
  timezone?: string;
  dataRetentionDays?: number;
};

type Integration = { id: string; name: string; type: string; isActive: boolean };
type Audit = {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
};

export default function SettingsPage() {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [auditLogs, setAuditLogs] = useState<Audit[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");

  async function load() {
    const [settingsRes, channelsRes] = await Promise.all([
      fetch("/api/settings"),
      fetch("/api/messaging-channels"),
    ]);
    if (settingsRes.ok) {
      const json = await settingsRes.json();
      setOrg(json.organisation);
      setMembers(json.members || []);
      setIntegrations(json.integrations || []);
      setAuditLogs(json.auditLogs || []);
    }
    if (channelsRes.ok) {
      const json = await channelsRes.json();
      setChannels(json.channels || []);
    }
  }

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Settings & integrations</h1>
        <p className="text-[var(--muted)]">Organisation, team, integrations, and audit trail.</p>
      </div>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Organisation</h2>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-[var(--muted)]">Name</dt>
            <dd className="font-medium">{org?.name}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Slug</dt>
            <dd className="font-medium">{org?.slug}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Timezone</dt>
            <dd className="font-medium">{org?.timezone}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Data retention (days)</dt>
            <dd className="font-medium">{org?.dataRetentionDays}</dd>
          </div>
        </dl>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Messaging channels</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Map ManyChat <code>channel_id</code> values to this organisation for webhook routing.
        </p>
        <form onSubmit={saveChannel} className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="text-sm font-medium">
            External channel id
            <input
              className="input mt-2"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              required
              placeholder="ig_channel_123"
            />
          </label>
          <label className="text-sm font-medium">
            Display name
            <input
              className="input mt-2"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Main Instagram"
            />
          </label>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Save channel mapping
            </button>
          </div>
        </form>
        <ul className="mt-4 space-y-2 text-sm">
          {channels.map((channel) => (
            <li key={channel.id} className="flex justify-between gap-3 border-b border-[var(--border)] py-2">
              <span>
                {channel.displayName}
                <span className="block text-xs text-[var(--muted)]">
                  {channel.provider}:{channel.externalId}
                </span>
              </span>
              <span className="badge">{channel.isActive ? "Active" : "Inactive"}</span>
            </li>
          ))}
          {!channels.length && <li className="text-[var(--muted)]">No channels configured yet.</li>}
        </ul>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Team members</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {members.map((m) => (
            <li key={m.id} className="flex justify-between gap-3 border-b border-[var(--border)] py-2">
              <span>
                {m.user.name || m.user.email}
                <span className="block text-xs text-[var(--muted)]">{m.user.email}</span>
              </span>
              <span className="badge">{m.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Integrations</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[
            ["ManyChat / Instagram", "Mock transport locally. Set MANYCHAT_* for live. Map channel_id above."],
            ["AI providers", "Configure mock, OpenAI, or Anthropic in AI Agent settings."],
            ["Booking", "DEFAULT_BOOKING_URL + booking webhook; adapter creates tracked links."],
            ["Google Sheets / Email", "Reports export uses mock adapters until credentials are set."],
            ["Redis / BullMQ", "Required for production workers. Optional locally with in-process fallback."],
          ].map(([title, body]) => (
            <div key={title} className="rounded-xl border border-[var(--border)] p-4">
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">{body}</p>
            </div>
          ))}
          {integrations.map((i) => (
            <div key={i.id} className="rounded-xl border border-[var(--border)] p-4">
              <h3 className="font-semibold">
                {i.name} ({i.type})
              </h3>
              <p className="text-sm text-[var(--muted)]">{i.isActive ? "Active" : "Inactive"}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Audit log</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {auditLogs.length === 0 && <li className="text-[var(--muted)]">No audit events yet.</li>}
          {auditLogs.map((log) => (
            <li key={log.id} className="border-b border-[var(--border)] py-2">
              <span className="font-medium">{log.action}</span>
              <span className="text-[var(--muted)]">
                {" "}
                · {log.entityType} {log.entityId?.slice(0, 8)} ·{" "}
                {new Date(log.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
