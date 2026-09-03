"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  isSuspended: boolean;
  isPlatformAdmin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  lockedUntil: string | null;
  activeSessions: number;
  memberships: Array<{ organisationId: string; organisationName: string; role: string }>;
};

export function UsersClient({ initial }: { initial: UserRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return rows.filter((u) => {
      if (q) {
        const hay = `${u.email} ${u.name || ""} ${u.memberships.map((m) => m.organisationName).join(" ")}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      if (status === "suspended" && !u.isSuspended) return false;
      if (status === "active" && (u.isSuspended || !u.isActive)) return false;
      if (role && !u.memberships.some((m) => m.role === role)) return false;
      return true;
    });
  }, [rows, q, role, status]);

  async function refresh() {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (role) params.set("role", role);
    if (status) params.set("status", status);
    const res = await fetch(`/api/admin/users?${params}`);
    if (!res.ok) return;
    const json = await res.json();
    setRows(json.users || []);
  }

  async function act(
    userId: string,
    action: string,
    extra?: { organisationId?: string; role?: string },
  ) {
    setBusy(`${action}-${userId}`);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, userId, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Action failed");
      if (action === "send_password_reset") {
        toast.success(
          json.emailed
            ? "Password reset email sent — user must also change password on next login"
            : "Password reset issued — user must change password on next login (email not sent)",
        );
      } else {
        toast.success("Updated");
      }
      await refresh();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  function statusLabel(user: UserRow) {
    if (!user.isActive) return "Inactive";
    if (user.isSuspended) return "Suspended";
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) return "Locked";
    return "Active";
  }

  return (
    <div className="space-y-4">
      <div className="surface flex flex-wrap gap-3 p-4">
        <input
          className="min-w-[200px] flex-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
          placeholder="Search name, email, workspace"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="">All roles</option>
          {["SUPER_ADMIN", "OWNER", "ADMINISTRATOR", "MANAGER", "SALES_AGENT", "ANALYST", "READ_ONLY"].map(
            (r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ),
          )}
        </select>
        <select
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
        <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-3 py-3">Name</th>
              <th className="px-3 py-3">Email</th>
              <th className="px-3 py-3">Role / Workspace</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Last login</th>
              <th className="px-3 py-3">Created</th>
              <th className="px-3 py-3">Sessions</th>
              <th className="px-3 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((user) => (
              <tr key={user.id} className="border-b border-[var(--border)]/60 align-top">
                <td className="px-3 py-3 font-medium">{user.name || "—"}</td>
                <td className="px-3 py-3">{user.email}</td>
                <td className="px-3 py-3 text-xs">
                  {user.memberships.length === 0
                    ? "—"
                    : user.memberships.map((m) => (
                        <div key={`${m.organisationId}-${m.role}`}>
                          {m.role} · {m.organisationName}
                        </div>
                      ))}
                  {user.isPlatformAdmin && <div className="badge mt-1">Platform admin</div>}
                </td>
                <td className="px-3 py-3">{statusLabel(user)}</td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "Never"}
                </td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-3">{user.activeSessions}</td>
                <td className="px-3 py-3">
                  <div className="flex min-w-[150px] flex-col gap-1 text-left">
                    {user.isSuspended ? (
                      <button
                        type="button"
                        className="text-[var(--accent)] hover:underline"
                        disabled={busy === `reactivate-${user.id}`}
                        onClick={() => void act(user.id, "reactivate")}
                      >
                        Reactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-[var(--danger)] hover:underline"
                        disabled={busy === `suspend-${user.id}`}
                        onClick={() => void act(user.id, "suspend")}
                      >
                        Suspend
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-[var(--accent)] hover:underline"
                      disabled={busy === `revoke_sessions-${user.id}`}
                      onClick={() => void act(user.id, "revoke_sessions")}
                    >
                      Revoke sessions
                    </button>
                    <button
                      type="button"
                      className="text-[var(--accent)] hover:underline"
                      disabled={busy === `send_password_reset-${user.id}`}
                      onClick={() => void act(user.id, "send_password_reset")}
                    >
                      Send password reset
                    </button>
                    <button
                      type="button"
                      className="text-[var(--accent)] hover:underline"
                      disabled={busy === `verify-${user.id}`}
                      onClick={() => void act(user.id, "verify")}
                    >
                      Verify account
                    </button>
                    {user.memberships[0] && (
                      <label className="text-xs text-[var(--muted)]">
                        Change role
                        <select
                          className="mt-1 block w-full rounded border border-[var(--border)] px-1 py-1"
                          defaultValue={user.memberships[0].role}
                          onChange={(e) =>
                            void act(user.id, "change_role", {
                              organisationId: user.memberships[0].organisationId,
                              role: e.target.value,
                            })
                          }
                        >
                          {[
                            "OWNER",
                            "ADMINISTRATOR",
                            "MANAGER",
                            "SALES_AGENT",
                            "ANALYST",
                            "READ_ONLY",
                          ].map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <a className="text-[var(--accent)] hover:underline" href="/admin/audit">
                      Audit history
                    </a>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="p-6 text-sm text-[var(--muted)]">No users match these filters.</p>
        )}
      </div>
    </div>
  );
}
