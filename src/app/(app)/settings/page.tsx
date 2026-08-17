"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

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

type ProviderStatus = {
  ai?: { adapter?: string; hasOpenAiKey?: boolean; hasAnthropicKey?: boolean };
  manychat?: { apiTokenConfigured?: boolean; adapter?: string };
  booking?: { defaultUrlConfigured?: boolean; adapter?: string };
  email?: { smtpConfigured?: boolean };
};

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`badge ${ok ? "" : "badge-warn"}`}>{label}</span>
  );
}

export default function SettingsPage() {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [providers, setProviders] = useState<ProviderStatus>({});
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [bookingUrl, setBookingUrl] = useState("");

  async function load() {
    const [settingsRes, channelsRes, providersRes] = await Promise.all([
      fetch("/api/settings"),
      fetch("/api/messaging-channels"),
      fetch("/api/health/providers"),
    ]);
    if (settingsRes.ok) {
      const json = await settingsRes.json();
      setOrg(json.organisation);
      setMembers(json.members || []);
      setIntegrations(json.integrations || []);
    }
    if (channelsRes.ok) {
      const json = await channelsRes.json();
      setChannels(json.channels || []);
    }
    if (providersRes.ok) {
      const json = await providersRes.json();
      setProviders(json.providers || {});
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
    toast.success("Instagram channel connected");
    setExternalId("");
    setDisplayName("");
    await load();
  }

  const instagramConnected =
    Boolean(providers.manychat?.apiTokenConfigured) ||
    channels.some((c) => c.isActive);
  const aiReady =
    Boolean(providers.ai?.hasAnthropicKey) ||
    (providers.ai?.adapter &&
      providers.ai.adapter !== "not_configured" &&
      providers.ai.adapter !== "openai");
  const calendarConnected = Boolean(providers.booking?.defaultUrlConfigured);
  const emailConnected = Boolean(providers.email?.smtpConfigured);

  return (
    <div className="space-y-6">
      <PageHeader
        description="Business, AI operator, team, and connections — keep it simple."
        actions={
          <Link href="/settings/go-live" className="btn btn-primary">
            Go Live checklist
          </Link>
        }
      />

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Business</h2>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-[var(--muted)]">Business name</dt>
            <dd className="font-medium">{org?.name || "—"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Timezone</dt>
            <dd className="font-medium">{org?.timezone || "UTC"}</dd>
          </div>
        </dl>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">AI Operator</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Autopilot runs your pipeline. Tune tone and goals in AI Agent when needed.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <StatusChip ok={Boolean(aiReady)} label={aiReady ? "Claude Ready" : "Claude Needs Setup"} />
          <Link href="/autopilot" className="btn btn-secondary">
            Autopilot
          </Link>
          <Link href="/agent" className="btn btn-secondary">
            Tone & goals
          </Link>
          <Link href="/setup" className="btn btn-secondary">
            Setup Assistant
          </Link>
        </div>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Connections</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-[var(--border)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">Instagram</h3>
              <StatusChip
                ok={instagramConnected}
                label={instagramConnected ? "Connected" : "Not Connected"}
              />
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Connect via ManyChat so Autopilot can reply to DMs.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowAdvanced(true)}
              >
                Connect
              </button>
              <Link href="/simulator" className="btn btn-secondary">
                Test
              </Link>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">Calendar</h3>
              <StatusChip
                ok={calendarConnected}
                label={calendarConnected ? "Connected" : "Not Connected"}
              />
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Booking link used when a lead is ready to speak.
            </p>
            <label className="mt-3 block text-sm">
              Booking URL
              <input
                className="input mt-1"
                value={bookingUrl}
                onChange={(e) => setBookingUrl(e.target.value)}
                placeholder="Your booking page URL"
              />
            </label>
            <p className="mt-2 text-xs text-[var(--muted)]">
              Set the default booking URL in AI Agent for this workspace.
            </p>
            <Link href="/agent" className="btn btn-secondary mt-3">
              Manage
            </Link>
          </div>

          <div className="rounded-xl border border-[var(--border)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">AI Operator</h3>
              <StatusChip
                ok={Boolean(aiReady)}
                label={aiReady ? "Claude Connected" : "Claude Needs Setup"}
              />
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">Powered by Anthropic Claude.</p>
            <Link href="/agent" className="btn btn-secondary mt-3">
              Manage
            </Link>
          </div>

          <div className="rounded-xl border border-[var(--border)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">Email</h3>
              <StatusChip
                ok={emailConnected}
                label={emailConnected ? "Connected" : "Not Connected"}
              />
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Optional for report delivery and notifications.
            </p>
          </div>
        </div>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Team</h2>
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
        <h2 className="h-display text-2xl">Security</h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link href="/account/change-password" className="btn btn-secondary">
            Change password
          </Link>
        </div>
      </section>

      {(showAdvanced || channels.length > 0) && (
        <section className="surface p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="h-display text-2xl">Advanced · Instagram channel</h2>
            <button
              type="button"
              className="text-sm text-[var(--accent)] hover:underline"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? "Hide" : "Show"}
            </button>
          </div>
          {showAdvanced && (
            <>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Paste the Instagram channel identifier from your ManyChat connection wizard.
              </p>
              <form onSubmit={saveChannel} className="mt-4 grid gap-3 md:grid-cols-3">
                <label className="text-sm font-medium">
                  Channel ID
                  <input
                    className="input mt-2"
                    value={externalId}
                    onChange={(e) => setExternalId(e.target.value)}
                    required
                    placeholder="Your Instagram channel"
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
                    Save
                  </button>
                </div>
              </form>
              <ul className="mt-4 space-y-2 text-sm">
                {channels.map((channel) => (
                  <li
                    key={channel.id}
                    className="flex justify-between gap-3 border-b border-[var(--border)] py-2"
                  >
                    <span>
                      {channel.displayName}
                      <span className="block text-xs text-[var(--muted)]">
                        {channel.externalId}
                      </span>
                    </span>
                    <span className="badge">{channel.isActive ? "Active" : "Inactive"}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {integrations.length > 0 && (
        <section className="surface p-5">
          <h2 className="h-display text-2xl">Saved integrations</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {integrations.map((i) => (
              <div key={i.id} className="rounded-xl border border-[var(--border)] p-4">
                <h3 className="font-semibold">{i.name}</h3>
                <p className="text-sm text-[var(--muted)]">{i.isActive ? "Active" : "Inactive"}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
