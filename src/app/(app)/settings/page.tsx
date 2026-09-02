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
  userId: string;
  role: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    isPlatformAdmin?: boolean;
  };
};

type PendingInvite = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
};

const INVITE_ROLE_OPTIONS = [
  "ADMINISTRATOR",
  "MANAGER",
  "SALES_AGENT",
  "ANALYST",
  "READ_ONLY",
] as const;

const MEMBER_ROLE_OPTIONS = ["OWNER", ...INVITE_ROLE_OPTIONS] as const;

type OrgInfo = {
  name?: string;
  slug?: string;
  timezone?: string;
  dataRetentionDays?: number;
};

type Integration = { id: string; name: string; type: string; isActive: boolean };

type ProviderStatus = {
  ai?: { ready?: boolean; status?: string; label?: string };
  manychat?: { apiTokenConfigured?: boolean; status?: string; adapter?: string };
  booking?: { defaultUrlConfigured?: boolean; status?: string; adapter?: string };
  email?: { smtpConfigured?: boolean; status?: string };
};

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`badge ${ok ? "" : "badge-warn"}`}>{label}</span>
  );
}

export default function SettingsPage() {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<PendingInvite[]>([]);
  const [canManageMembers, setCanManageMembers] = useState(false);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [providers, setProviders] = useState<ProviderStatus>({});
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [bookingUrl, setBookingUrl] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("SALES_AGENT");
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  async function load() {
    const [settingsRes, channelsRes, providersRes, membersRes] = await Promise.all([
      fetch("/api/settings"),
      fetch("/api/messaging-channels"),
      fetch("/api/health/providers"),
      fetch("/api/workspace/members"),
    ]);
    if (settingsRes.ok) {
      const json = await settingsRes.json();
      setOrg(json.organisation);
      setIntegrations(json.integrations || []);
      if (!membersRes.ok) {
        // Fallback: settings still returns basic member list for read-only viewers.
        setMembers(
          (json.members || []).map(
            (m: {
              id: string;
              userId?: string;
              role: string;
              user: { email: string; name: string | null };
            }) => ({
              id: m.id,
              userId: m.userId || m.id,
              role: m.role,
              user: { id: m.userId || m.id, email: m.user.email, name: m.user.name },
            }),
          ),
        );
      }
    }
    if (membersRes.ok) {
      const json = await membersRes.json();
      setCanManageMembers(true);
      setMembers(json.members || []);
      setInvitations(json.invitations || []);
    } else {
      setCanManageMembers(false);
      setInvitations([]);
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

  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    setInviteBusy(true);
    setLastInviteUrl(null);
    try {
      const res = await fetch("/api/workspace/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Invite failed");
        return;
      }
      if (json.emailSent) {
        toast.success("Invitation email sent");
      } else {
        toast.message(json.emailError || "Email not sent — copy the invite link");
        if (json.inviteUrl) setLastInviteUrl(json.inviteUrl);
      }
      if (json.inviteUrl && json.emailSent) setLastInviteUrl(json.inviteUrl);
      setInviteEmail("");
      await load();
    } finally {
      setInviteBusy(false);
    }
  }

  async function resendInvite(id: string) {
    const res = await fetch(`/api/workspace/invitations/${id}/resend`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Resend failed");
      return;
    }
    if (json.emailSent) toast.success("Invitation resent");
    else {
      toast.message(json.emailError || "Email not sent — copy the invite link");
      if (json.inviteUrl) setLastInviteUrl(json.inviteUrl);
    }
    await load();
  }

  async function revokeInvite(id: string) {
    const res = await fetch(`/api/workspace/invitations/${id}/revoke`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Revoke failed");
      return;
    }
    toast.success("Invitation revoked");
    await load();
  }

  async function changeRole(userId: string, role: string) {
    const res = await fetch(`/api/workspace/members/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "role", role }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Role change failed");
      return;
    }
    toast.success("Role updated");
    await load();
  }

  async function removeMember(userId: string) {
    if (!window.confirm("Remove this member from the workspace?")) return;
    const res = await fetch(`/api/workspace/members/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove" }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Remove failed");
      return;
    }
    toast.success("Member removed");
    await load();
  }

  async function copyInviteLink() {
    if (!lastInviteUrl) return;
    try {
      await navigator.clipboard.writeText(lastInviteUrl);
      toast.success("Invite link copied");
    } catch {
      toast.message(lastInviteUrl);
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
    Boolean(providers.ai?.ready) || providers.ai?.status === "AVAILABLE";
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
        <p className="mt-1 text-sm text-[var(--muted)]">
          Members and pending invitations for this workspace.
        </p>

        {canManageMembers && (
          <form onSubmit={sendInvite} className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_auto]">
            <label className="text-sm font-medium">
              Invite email
              <input
                className="input mt-1"
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@company.com"
              />
            </label>
            <label className="text-sm font-medium">
              Role
              <select
                className="input mt-1"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
              >
                {INVITE_ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {role.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button className="btn btn-primary w-full" type="submit" disabled={inviteBusy}>
                {inviteBusy ? "Sending…" : "Invite"}
              </button>
            </div>
          </form>
        )}

        {lastInviteUrl && (
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm">
            <p className="text-[var(--muted)]">Invite link (share if email was not delivered):</p>
            <p className="mt-1 break-all font-mono text-xs">{lastInviteUrl}</p>
            <button type="button" className="btn btn-secondary mt-2" onClick={copyInviteLink}>
              Copy link
            </button>
          </div>
        )}

        <ul className="mt-4 space-y-2 text-sm">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] py-2"
            >
              <span>
                {m.user.name || m.user.email}
                <span className="block text-xs text-[var(--muted)]">{m.user.email}</span>
                {m.user.isPlatformAdmin ? (
                  <span className="mt-1 inline-block text-xs text-[var(--muted)]">
                    Platform admin (flag — not a workspace role)
                  </span>
                ) : null}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {canManageMembers ? (
                  <>
                    <select
                      className="input py-1 text-xs"
                      aria-label={`Role for ${m.user.email}`}
                      value={m.role}
                      onChange={(e) => changeRole(m.userId, e.target.value)}
                    >
                      {MEMBER_ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>
                          {role.replace(/_/g, " ")}
                        </option>
                      ))}
                      {m.role === "SUPER_ADMIN" ? (
                        <option value="SUPER_ADMIN">SUPER ADMIN</option>
                      ) : null}
                    </select>
                    <button
                      type="button"
                      className="btn btn-secondary py-1 text-xs"
                      onClick={() => removeMember(m.userId)}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <span className="badge">{m.role}</span>
                )}
              </div>
            </li>
          ))}
        </ul>

        {canManageMembers && invitations.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold">Pending invitations</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {invitations.map((inv) => (
                <li
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] py-2"
                >
                  <span>
                    {inv.email}
                    <span className="block text-xs text-[var(--muted)]">
                      {inv.role.replace(/_/g, " ")} · expires{" "}
                      {new Date(inv.expiresAt).toLocaleDateString()}
                    </span>
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-secondary py-1 text-xs"
                      onClick={() => resendInvite(inv.id)}
                    >
                      Resend
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary py-1 text-xs"
                      onClick={() => revokeInvite(inv.id)}
                    >
                      Revoke
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
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
              <Link href="/integrations?setup=manychat" className="btn btn-primary">
                Configure
              </Link>
              <Link href="/integrations#manychat-setup" className="btn btn-secondary">
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
              <h3 className="font-semibold">Agent Desk intelligence</h3>
              <StatusChip
                ok={Boolean(aiReady)}
                label={aiReady ? "Available" : "Unavailable"}
              />
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Powers replies, research, and Ask — configure brand voice and behaviour.
            </p>
            <Link href="/agent" className="btn btn-secondary mt-3">
              Manage behaviour
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
