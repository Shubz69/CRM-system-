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
        description="Workspace, team, AI behaviour, messaging, and security — keep controls clear."
        actions={
          <Link href="/settings/go-live" className="btn btn-primary">
            Setup progress
          </Link>
        }
      />

      <div className="flex flex-col gap-6 lg:flex-row">
        <nav
          className="hidden w-48 shrink-0 space-y-1 lg:block"
          aria-label="Settings categories"
        >
          {[
            ["workspace", "Workspace"],
            ["team", "Team"],
            ["ai", "AI behaviour"],
            ["messaging", "Messaging"],
            ["qualification", "Qualification"],
            ["brand", "Brand & policies"],
            ["notifications", "Notifications"],
            ["security", "Security"],
            ["advanced", "Advanced"],
          ].map(([id, label]) => (
            <a
              key={id}
              href={`#settings-${id}`}
              className="block rounded-lg px-3 py-2 text-sm text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-6">
          <label className="block lg:hidden">
            <span className="sr-only">Settings section</span>
            <select
              className="input w-full"
              aria-label="Settings section"
              defaultValue="workspace"
              onChange={(e) => {
                const el = document.getElementById(`settings-${e.target.value}`);
                el?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {[
                ["workspace", "Workspace"],
                ["team", "Team"],
                ["ai", "AI behaviour"],
                ["messaging", "Messaging"],
                ["qualification", "Qualification"],
                ["brand", "Brand & policies"],
                ["notifications", "Notifications"],
                ["security", "Security"],
                ["advanced", "Advanced"],
              ].map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>

      <section id="settings-workspace" className="surface scroll-mt-24 p-5">
        <h2 className="section-title">Workspace</h2>
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

      <section id="settings-team" className="surface scroll-mt-24 p-5">
        <h2 className="section-title">Team</h2>
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

      <section id="settings-ai" className="surface scroll-mt-24 p-5">
        <h2 className="section-title">AI behaviour</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          How much Agent Desk can do automatically, tone, and when to hand off to humans.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <StatusChip ok={Boolean(aiReady)} label={aiReady ? "AI ready" : "AI needs setup"} />
          <Link href="/autopilot" className="btn btn-secondary">
            Automation level
          </Link>
          <Link href="/agent" className="btn btn-secondary">
            Tone & goals
          </Link>
          <Link href="/setup" className="btn btn-secondary">
            Setup Assistant
          </Link>
        </div>
      </section>

      <section id="settings-messaging" className="surface scroll-mt-24 p-5">
        <h2 className="section-title">Messaging</h2>
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
              Connect via ManyChat so Agent Desk can reply to DMs.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowAdvanced(true)}
              >
                Connect
              </button>
              <Link href="/integrations" className="btn btn-secondary">
                Integrations
              </Link>
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
            <Link href="/agent" className="btn btn-secondary mt-3">
              Manage
            </Link>
          </div>

          <div className="rounded-xl border border-[var(--border)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">AI provider</h3>
              <StatusChip
                ok={Boolean(aiReady)}
                label={aiReady ? "Connected" : "Needs setup"}
              />
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">Powers replies, research, and Ask.</p>
            <Link href="/integrations" className="btn btn-secondary mt-3">
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

      <section id="settings-qualification" className="surface scroll-mt-24 p-5">
        <h2 className="section-title">Qualification</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Score thresholds, fit criteria, and when to hand off a lead.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link href="/qualification" className="btn btn-secondary">
            Qualification rules
          </Link>
        </div>
      </section>

      <section id="settings-brand" className="surface scroll-mt-24 p-5">
        <h2 className="section-title">Brand & policies</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Tone of voice, pricing, and policy documents that guide AI replies.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link href="/knowledge" className="btn btn-secondary">
            Knowledge library
          </Link>
          <Link href="/business-context" className="btn btn-secondary">
            Business profile
          </Link>
        </div>
      </section>

      <section id="settings-notifications" className="surface scroll-mt-24 p-5">
        <h2 className="section-title">Notifications</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Alerts for handoffs, approvals, and publish confirmation stay in the header notification menu.
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Email delivery depends on SMTP being connected above.
        </p>
      </section>

      <section id="settings-security" className="surface scroll-mt-24 p-5">
        <h2 className="section-title">Security</h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link href="/account/change-password" className="btn btn-secondary">
            Change password
          </Link>
        </div>
      </section>

      <section id="settings-advanced" className="surface scroll-mt-24 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">Advanced</h2>
          <button
            type="button"
            className="text-sm text-[var(--accent)] hover:underline"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "Hide" : "Show"}
          </button>
        </div>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Channel identifiers and engineering controls. Platform-level shadow flags live under Admin, not here.
        </p>
        {(showAdvanced || channels.length > 0) && (
          <>
            <p className="mt-3 text-sm font-medium">Instagram channel</p>
            <form onSubmit={saveChannel} className="mt-2 grid gap-3 md:grid-cols-3">
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

      {integrations.length > 0 && (
        <section className="surface p-5">
          <h2 className="section-title">Saved integrations</h2>
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
      </div>
    </div>
  );
}
