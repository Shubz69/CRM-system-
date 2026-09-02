"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  autopilotMode: string;
  owner: { id: string; email: string; name: string | null } | null;
  users: number;
  contacts: number;
  conversations: number;
  aiStatus: string;
  manychatStatus: string;
  bookingStatus: string;
  createdAt: string;
  lastActivityAt: string | null;
  demoData: boolean;
  betaStatus?: string | null;
  betaLabel?: string | null;
  connectedSocialCount?: number;
  socialLimit?: number | null;
  pendingInvites?: Array<{
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: string;
  }>;
  aiBudgetMonthlyCapCents?: number | null;
};

type SocialPolicy = {
  socialConnectionsEnabled: boolean;
  maxConnectedSocialAccounts: number | null;
  allowedNetworks: Array<"INSTAGRAM" | "LINKEDIN" | "YOUTUBE">;
};

function SocialAccessControls({
  organisationId,
  busy,
  setBusy,
}: {
  organisationId: string;
  busy: string | null;
  setBusy: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<SocialPolicy | null>(null);
  const [connectedCount, setConnectedCount] = useState<number | null>(null);

  async function load() {
    setBusy(`social-${organisationId}`);
    try {
      const res = await fetch(
        `/api/admin/social-connection-policy?organisationId=${encodeURIComponent(organisationId)}`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load social access");
      setPolicy(json.policy);
      setConnectedCount(json.connectedCount ?? null);
      setOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Load failed");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!policy) return;
    setBusy(`social-save-${organisationId}`);
    try {
      const res = await fetch("/api/admin/social-connection-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organisationId,
          socialConnectionsEnabled: policy.socialConnectionsEnabled,
          maxConnectedSocialAccounts: policy.maxConnectedSocialAccounts,
          allowedNetworks: policy.allowedNetworks,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setPolicy(json.policy);
      toast.success("Social access updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  function toggleNetwork(n: SocialPolicy["allowedNetworks"][number]) {
    if (!policy) return;
    const has = policy.allowedNetworks.includes(n);
    setPolicy({
      ...policy,
      allowedNetworks: has
        ? policy.allowedNetworks.filter((x) => x !== n)
        : [...policy.allowedNetworks, n],
    });
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="text-left text-[var(--accent)] hover:underline"
        disabled={busy === `social-${organisationId}`}
        onClick={() => void (open ? setOpen(false) : load())}
      >
        Social Access
      </button>
      {open && policy ? (
        <div className="mt-1 space-y-2 rounded border border-[var(--border)] bg-[var(--surface-2)] p-2 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={policy.socialConnectionsEnabled}
              onChange={(e) =>
                setPolicy({ ...policy, socialConnectionsEnabled: e.target.checked })
              }
            />
            Connections enabled
          </label>
          <label className="block">
            Max connected accounts
            <input
              className="mt-1 w-20 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
              type="number"
              min={0}
              value={policy.maxConnectedSocialAccounts ?? ""}
              placeholder="∞"
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  maxConnectedSocialAccounts:
                    e.target.value === "" ? null : Math.max(0, Number(e.target.value)),
                })
              }
            />
          </label>
          <div className="space-y-1">
            <p>Allowed networks</p>
            {(["INSTAGRAM", "LINKEDIN", "YOUTUBE"] as const).map((n) => (
              <label key={n} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={policy.allowedNetworks.includes(n)}
                  onChange={() => toggleNetwork(n)}
                />
                {n.charAt(0) + n.slice(1).toLowerCase()}
              </label>
            ))}
          </div>
          {connectedCount != null ? (
            <p className="text-[var(--muted)]">Currently connected: {connectedCount}</p>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={busy === `social-save-${organisationId}`}
            onClick={() => void save()}
          >
            Save social access
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspacesClient({ initial }: { initial: WorkspaceRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);

  // Beta create form
  const [orgName, setOrgName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [betaLabel, setBetaLabel] = useState("Beta");
  const [socialMax, setSocialMax] = useState(2);
  const [networks, setNetworks] = useState<Array<"INSTAGRAM" | "LINKEDIN" | "YOUTUBE">>([
    "INSTAGRAM",
    "LINKEDIN",
    "YOUTUBE",
  ]);

  async function refresh() {
    const res = await fetch("/api/admin/workspaces");
    if (!res.ok) return;
    const json = await res.json();
    setRows(json.workspaces || []);
  }

  async function createBeta(e: FormEvent) {
    e.preventDefault();
    setBusy("create-beta");
    setLastInviteUrl(null);
    try {
      const res = await fetch("/api/admin/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_beta",
          name: orgName,
          ownerFullName: ownerName,
          ownerEmail,
          role: "OWNER",
          betaLabel: betaLabel || "Beta",
          socialConnectionsEnabled: true,
          maxConnectedSocialAccounts: socialMax,
          allowedNetworks: networks,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Create failed");
      const url = json.invite?.inviteUrl as string | undefined;
      setLastInviteUrl(url || null);
      if (json.invite?.emailSent) {
        toast.success("Beta workspace created — invite email sent");
      } else {
        toast.success("Beta workspace created — copy invite link below");
      }
      setOrgName("");
      setOwnerName("");
      setOwnerEmail("");
      await refresh();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(null);
    }
  }

  async function mutate(
    organisationId: string,
    action: string,
    extra?: object,
  ) {
    setBusy(`${action}-${organisationId}`);
    try {
      const res = await fetch("/api/admin/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, organisationId, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Action failed");
      if (json.invite?.inviteUrl) {
        setLastInviteUrl(json.invite.inviteUrl);
        toast.success("Invite ready — copy link below");
      } else {
        toast.success(
          action === "suspend"
            ? "Suspended"
            : action === "reactivate"
              ? "Reactivated"
              : "Saved",
        );
      }
      await refresh();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied");
    } catch {
      toast.error("Could not copy — select the link manually");
    }
  }

  function toggleNetwork(n: "INSTAGRAM" | "LINKEDIN" | "YOUTUBE") {
    setNetworks((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n],
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={createBeta} className="surface space-y-4 p-4">
        <div>
          <h2 className="text-base font-medium">Create Beta Workspace</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Create organisation + OWNER invite in one step. Copy link works without email.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="text-[var(--muted)]">Organisation name</span>
            <input
              className="mt-1 block w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              required
            />
          </label>
          <label className="text-sm">
            <span className="text-[var(--muted)]">Owner full name</span>
            <input
              className="mt-1 block w-48 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              required
            />
          </label>
          <label className="text-sm">
            <span className="text-[var(--muted)]">Owner email</span>
            <input
              className="mt-1 block w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              required
            />
          </label>
          <label className="text-sm">
            <span className="text-[var(--muted)]">Beta label</span>
            <input
              className="mt-1 block w-32 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              value={betaLabel}
              onChange={(e) => setBetaLabel(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="text-[var(--muted)]">Social max</span>
            <input
              className="mt-1 block w-20 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              type="number"
              min={0}
              max={10}
              value={socialMax}
              onChange={(e) => setSocialMax(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          {(["INSTAGRAM", "LINKEDIN", "YOUTUBE"] as const).map((n) => (
            <label key={n} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={networks.includes(n)}
                onChange={() => toggleNetwork(n)}
              />
              {n.charAt(0) + n.slice(1).toLowerCase()}
            </label>
          ))}
        </div>
        <button className="btn btn-primary" disabled={busy === "create-beta"} type="submit">
          {busy === "create-beta" ? "Creating…" : "Create & Invite"}
        </button>
        {lastInviteUrl ? (
          <div className="rounded border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm">
            <p className="font-medium">Invite link</p>
            <p className="mt-1 break-all text-[var(--muted)]">{lastInviteUrl}</p>
            <button
              type="button"
              className="btn btn-secondary mt-2 text-xs"
              onClick={() => void copyLink(lastInviteUrl)}
            >
              Copy Invite Link
            </button>
          </div>
        ) : null}
      </form>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[1200px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-3 py-3">Organisation</th>
              <th className="px-3 py-3">Owner</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Beta</th>
              <th className="px-3 py-3">Members</th>
              <th className="px-3 py-3">Social</th>
              <th className="px-3 py-3">AI budget</th>
              <th className="px-3 py-3">Created</th>
              <th className="px-3 py-3">Activity</th>
              <th className="px-3 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((org) => (
              <tr key={org.id} className="border-b border-[var(--border)]/60 align-top">
                <td className="px-3 py-3">
                  <div className="font-medium">{org.name}</div>
                  <div className="text-xs text-[var(--muted)]">{org.slug}</div>
                </td>
                <td className="px-3 py-3 text-[var(--muted)]">
                  <div>{org.owner?.name || "—"}</div>
                  <div className="text-xs">{org.owner?.email || "Pending invite"}</div>
                </td>
                <td className="px-3 py-3">
                  <span className={org.status === "SUSPENDED" ? "badge badge-warn" : "badge"}>
                    {org.status}
                  </span>
                </td>
                <td className="px-3 py-3 text-xs">
                  {org.betaStatus || (org.plan === "beta" ? "BETA" : "—")}
                </td>
                <td className="px-3 py-3">{org.users}</td>
                <td className="px-3 py-3 text-xs">
                  {org.connectedSocialCount ?? 0}
                  {org.socialLimit != null ? ` / ${org.socialLimit}` : " / ∞"}
                </td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {org.aiBudgetMonthlyCapCents == null
                    ? "Unlimited"
                    : `$${(org.aiBudgetMonthlyCapCents / 100).toFixed(0)}/mo`}
                </td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {new Date(org.createdAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {org.lastActivityAt ? new Date(org.lastActivityAt).toLocaleString() : "—"}
                </td>
                <td className="px-3 py-3">
                  <div className="flex min-w-[160px] flex-col gap-1">
                    <a className="text-[var(--accent)] hover:underline" href={`/admin/users?organisationId=${org.id}`}>
                      Manage
                    </a>
                    <button
                      type="button"
                      className="text-left text-[var(--accent)] hover:underline"
                      disabled={busy === `invite-${org.id}`}
                      onClick={() => {
                        const email = window.prompt("Invite email");
                        if (!email) return;
                        void mutate(org.id, "invite", {
                          inviteEmail: email,
                          inviteRole: "ADMINISTRATOR",
                        });
                      }}
                    >
                      Invite
                    </button>
                    {(org.pendingInvites || []).slice(0, 3).map((inv) => (
                      <div key={inv.id} className="text-xs text-[var(--muted)]">
                        {inv.email}{" "}
                        <button
                          type="button"
                          className="text-[var(--accent)] hover:underline"
                          onClick={() =>
                            void mutate(org.id, "resend_invite", { inviteId: inv.id })
                          }
                        >
                          Resend
                        </button>{" "}
                        <button
                          type="button"
                          className="text-[var(--danger)] hover:underline"
                          onClick={() =>
                            void mutate(org.id, "revoke_invite", { inviteId: inv.id })
                          }
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                    <SocialAccessControls organisationId={org.id} busy={busy} setBusy={setBusy} />
                    <button
                      type="button"
                      className="text-left text-[var(--accent)] hover:underline"
                      onClick={() => {
                        const dollars = window.prompt(
                          "Monthly AI budget (USD). Empty = unlimited",
                          org.aiBudgetMonthlyCapCents != null
                            ? String(org.aiBudgetMonthlyCapCents / 100)
                            : "25",
                        );
                        if (dollars === null) return;
                        const monthlyCapCents =
                          dollars.trim() === ""
                            ? null
                            : Math.max(0, Math.round(Number(dollars) * 100));
                        void mutate(org.id, "set_ai_budget", {
                          monthlyCapCents,
                          warningThresholdCents:
                            monthlyCapCents == null
                              ? null
                              : Math.floor(monthlyCapCents * 0.8),
                        });
                      }}
                    >
                      Set AI budget
                    </button>
                    {org.status === "SUSPENDED" ? (
                      <button
                        type="button"
                        className="text-left text-[var(--accent)] hover:underline"
                        disabled={busy === `reactivate-${org.id}`}
                        onClick={() => void mutate(org.id, "reactivate")}
                      >
                        Reactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-left text-[var(--danger)] hover:underline"
                        disabled={busy === `suspend-${org.id}`}
                        onClick={() => void mutate(org.id, "suspend")}
                      >
                        Suspend
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="p-6 text-sm text-[var(--muted)]">
            No organisations yet. Create a beta workspace above.
          </p>
        )}
      </div>
    </div>
  );
}
